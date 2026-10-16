import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const app = express();
const port = Number(process.env.PORT || 10000);
const owner = process.env.GITHUB_OWNER || 'kislhakk-ux';
const repo = process.env.GITHUB_REPO || 'SALGADOS';
const branch = process.env.GITHUB_BRANCH || 'main';
const catalogPath = 'catalog.json';
const seedPath = fileURLToPath(new URL('../catalog-seed.json', import.meta.url));
const loginAttempts = new Map();
const MAX_CATALOG_BYTES = 1_000_000;
const MAX_IMAGE_BYTES = 1_450_000;
const CATALOG_CACHE_TTL_MS = 10_000;
let catalogCache = null;
let catalogCacheExpiresAt = 0;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '2mb', type: 'application/json' }));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

function pathForApi(repoPath) {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}

async function githubRequest(repoPath, options = {}) {
  const token = required('GITHUB_TOKEN');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${pathForApi(repoPath)}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Nane-Catalog-Panel',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`GitHub returned ${response.status}${text ? `: ${text.slice(0, 350)}` : ''}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function readRepoFile(repoPath) {
  const response = await githubRequest(repoPath);
  if (response.type !== 'file') throw new Error('Expected a file in GitHub.');
  if (response.content) return { sha: response.sha, content: Buffer.from(response.content.replace(/\n/g, ''), 'base64') };
  if (!response.download_url || !response.download_url.startsWith('https://raw.githubusercontent.com/')) throw new Error('GitHub did not provide the file contents.');
  const raw = await fetch(response.download_url);
  if (!raw.ok) throw new Error(`Could not download file from GitHub (${raw.status}).`);
  return { sha: response.sha, content: Buffer.from(await raw.arrayBuffer()) };
}

async function loadCatalog() {
  if (catalogCache && Date.now() < catalogCacheExpiresAt) {
    return JSON.parse(JSON.stringify(catalogCache));
  }

  let catalog;
  try {
    const file = await readRepoFile(catalogPath);
    catalog = JSON.parse(file.content.toString('utf8'));
  } catch (error) {
    if (error.status !== 404) throw error;
    catalog = JSON.parse(await fs.readFile(seedPath, 'utf8'));
  }
  catalogCache = catalog;
  catalogCacheExpiresAt = Date.now() + CATALOG_CACHE_TTL_MS;
  return JSON.parse(JSON.stringify(catalogCache));
}

function validateCatalog(value) {
  if (!value || !Array.isArray(value.categories) || !Array.isArray(value.products) || !Array.isArray(value.beverages)) {
    throw new Error('O catálogo precisa conter categorias, produtos e bebidas.');
  }
  if (value.categories.length > 100 || value.products.length > 500 || value.beverages.length > 200) {
    throw new Error('O catálogo ultrapassou o limite de itens.');
  }
  const categoryById = new Map();
  for (const category of value.categories) {
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(category.id || '') || !['products', 'beverages'].includes(category.catalog)) {
      throw new Error('Uma categoria está com dados inválidos.');
    }
    category.name = String(category.name || '').trim().slice(0, 60);
    if (!category.name || categoryById.has(category.id)) throw new Error('Confira os nomes das categorias.');
    categoryById.set(category.id, category.catalog);
  }
  const ids = new Set();
  for (const [collectionName, collection] of [['products', value.products], ['beverages', value.beverages]]) {
    for (const item of collection) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.id || '')) throw new Error('Um item tem um identificador inválido.');
    if (ids.has(item.id)) throw new Error(`O identificador “${item.id}” está repetido.`);
    ids.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) throw new Error('Confira o nome de cada item.');
    if (categoryById.get(item.category) !== collectionName) throw new Error(`A categoria de “${item.name}” não existe nesse catálogo.`);
    if (item.price != null && (!Number.isFinite(Number(item.price)) || Number(item.price) < 0 || Number(item.price) > 1_000_000)) {
      throw new Error(`Confira o preço de “${item.name}”.`);
    }
    if (typeof item.image !== 'string' || !/^assets\/[a-zA-Z0-9._/-]{1,240}$/.test(item.image) || item.image.includes('..')) throw new Error(`A imagem de “${item.name}” precisa estar na pasta de imagens do catálogo.`);
    item.name = item.name.trim();
    item.description = String(item.description || '').slice(0, 500);
    item.unitLabel = String(item.unitLabel || 'unidade').slice(0, 24);
    item.active = item.active !== false;
    }
  }
  return value;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload, required('SESSION_SECRET'))}`;
}

function requireAdmin(req, res, next) {
  const [payload, signature] = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload, required('SESSION_SECRET')))) {
    return res.status(401).json({ error: 'Sua sessão terminou. Entre novamente.' });
  }
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isFinite(session.exp) || session.exp < Date.now()) throw new Error('expired');
    next();
  } catch {
    return res.status(401).json({ error: 'Sua sessão terminou. Entre novamente.' });
  }
}

function checkLoginLimit(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 8) return false;
  recent.push(now);
  loginAttempts.set(ip, recent);
  return true;
}

app.get('/', (_req, res) => res.json({ service: 'Nane Catálogo API', status: 'ok' }));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

app.get('/api/catalog', async (_req, res) => {
  try {
    const catalog = await loadCatalog();
    res.set('Cache-Control', 'no-store').json(catalog);
  } catch (error) {
    console.error('Catalog read failed:', error.message);
    res.status(503).json({ error: 'O catálogo está carregando. Tente novamente em instantes.' });
  }
});

app.get('/api/image', async (req, res) => {
  const repoPath = String(req.query.path || '');
  if (!/^assets\/[a-zA-Z0-9._/-]{1,240}$/.test(repoPath) || repoPath.includes('..')) {
    return res.status(400).json({ error: 'Imagem inválida.' });
  }
  try {
    const file = await readRepoFile(repoPath);
    const extension = path.extname(repoPath).toLowerCase();
    const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
    res.set({ 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    res.send(file.content);
  } catch (error) {
    res.status(error.status === 404 ? 404 : 503).json({ error: 'Não foi possível carregar a foto.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkLoginLimit(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
  const expected = required('ADMIN_PASSWORD');
  if (!safeEqual(req.body?.password || '', expected)) return res.status(401).json({ error: 'Senha incorreta.' });
  res.set('Cache-Control', 'no-store').json({ token: createToken(), expiresIn: 8 * 60 * 60 });
});

app.get('/api/admin/catalog', requireAdmin, async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(await loadCatalog());
  } catch (error) {
    console.error('Admin catalog read failed:', error.message);
    res.status(503).json({ error: 'Não foi possível abrir o catálogo do GitHub.' });
  }
});

app.put('/api/admin/catalog', requireAdmin, async (req, res) => {
  try {
    const catalog = validateCatalog(req.body);
    const content = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    if (content.length > MAX_CATALOG_BYTES) return res.status(413).json({ error: 'O catálogo está grande demais.' });
    let sha;
    try { sha = (await readRepoFile(catalogPath)).sha; } catch (error) { if (error.status !== 404) throw error; }
    await githubRequest(catalogPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Atualizar catálogo Nane Salgados', content: content.toString('base64'), branch, ...(sha ? { sha } : {}) })
    });
    catalogCache = catalog;
    catalogCacheExpiresAt = Date.now() + CATALOG_CACHE_TTL_MS;
    res.set('Cache-Control', 'no-store').json({ ok: true, catalog });
  } catch (error) {
    console.error('Catalog save failed:', error.message);
    res.status(error.status && error.status < 500 ? error.status : 400).json({ error: error.message || 'Não foi possível salvar o catálogo.' });
  }
});

app.post('/api/admin/images', requireAdmin, async (req, res) => {
  const { dataBase64, filename = 'foto.jpg', mimeType = 'image/jpeg' } = req.body || {};
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) || typeof dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(dataBase64)) {
    return res.status(400).json({ error: 'Escolha uma foto JPEG, PNG ou WebP.' });
  }
  const image = Buffer.from(dataBase64, 'base64');
  if (!image.length || image.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'A foto ficou acima do limite de 1,4 MB. Escolha uma imagem menor.' });
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const slug = String(filename).replace(/\.[^.]+$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'produto';
  const repoPath = `assets/uploads/${slug}-${Date.now().toString(36)}.${extension}`;
  try {
    await githubRequest(repoPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Adicionar foto ao catálogo: ${slug}`, content: image.toString('base64'), branch })
    });
    res.status(201).json({ image: repoPath });
  } catch (error) {
    console.error('Image upload failed:', error.message);
    res.status(502).json({ error: 'Não foi possível salvar a imagem no GitHub. Confira a permissão do token.' });
  }
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled API error:', error.message);
  res.status(error.status || 500).json({ error: 'Ocorreu um erro. Tente novamente.' });
});

app.listen(port, '0.0.0.0', () => console.log(`Nane catalog API listening on ${port}`));
