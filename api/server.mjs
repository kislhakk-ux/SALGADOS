import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

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
const publicOrderAttempts = new Map();
const deviceCollectionName = 'adminDevices';
let firestore = null;
let firebaseMessaging = null;
let firebaseInitError = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const appName = 'nane-agenda-api';
    const firebaseApp = getApps().find((item) => item.name === appName) || initializeApp({
      credential: cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id
    }, appName);
    firestore = getFirestore(firebaseApp);
    firebaseMessaging = getMessaging(firebaseApp);
  } catch (error) {
    firebaseInitError = error;
    console.error('Firebase initialization failed:', error.message);
  }
}
let catalogCache = null;
let catalogCacheExpiresAt = 0;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
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
  if (!value.banners || typeof value.banners !== 'object' || Array.isArray(value.banners)) value.banners = {};
  if (value.banners.menuImage == null || value.banners.menuImage === '') value.banners.menuImage = 'assets/banner-cardapio.jpeg';
  if (typeof value.banners.menuImage !== 'string' || !/^assets\/[a-zA-Z0-9._/-]{1,240}$/.test(value.banners.menuImage) || value.banners.menuImage.includes('..')) {
    throw new Error('A imagem do banner precisa estar na pasta de imagens do catálogo.');
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

function createToken(lifetimeMs = 8 * 60 * 60 * 1000) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + lifetimeMs })).toString('base64url');
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

function database() {
  if (!firestore) {
    const error = new Error(firebaseInitError ? 'A conexão com o Firebase está inválida. Confira as variáveis secretas do servidor.' : 'A agenda online ainda não está configurada.');
    error.status = 503;
    throw error;
  }
  return firestore.collection('orders');
}

function adminDevices() {
  if (!firestore) database();
  return firestore.collection(deviceCollectionName);
}

function mobilePairings() {
  if (!firestore) database();
  return firestore.collection('mobilePairings');
}

function limitPublicOrder(ip) {
  const now = Date.now();
  const recent = (publicOrderAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 5) return false;
  recent.push(now);
  publicOrderAttempts.set(ip, recent);
  return true;
}

function validScheduledAt(value, requireLead = true) {
  const scheduledAt = new Date(value);
  const timestamp = scheduledAt.getTime();
  if (!Number.isFinite(timestamp) || (requireLead && timestamp < Date.now() + 2 * 60 * 60 * 1000) || timestamp > Date.now() + 370 * 24 * 60 * 60 * 1000) {
    throw new Error('Escolha um horário com pelo menos 2 horas de antecedência.');
  }
  return scheduledAt;
}

function normalizeOrderInput(value, existing = null) {
  const client = String(value?.client || '').trim().slice(0, 100);
  const phone = String(value?.phone || '').replace(/[^0-9+]/g, '').slice(0, 20);
  const date = String(value?.date || '').trim();
  const time = String(value?.time || '').trim();
  if (!client) throw new Error('Informe o nome do cliente.');
  if (!existing && phone.replace(/\D/g, '').length < 10) throw new Error('Confira o WhatsApp do cliente.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Confira a data e o horário do pedido.');
  const scheduledAt = validScheduledAt(value?.scheduledAt || existing?.scheduledAt, !existing);
  const dateCheck = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== date) throw new Error('A data do pedido não é válida.');
  const deliveryValue = value?.delivery ?? existing?.delivery;
  const delivery = ['delivery', 'Entrega'].includes(deliveryValue) ? 'delivery' : 'pickup';
  const address = String(value?.address ?? existing?.address ?? '').trim().slice(0, 300);
  if (delivery === 'delivery' && !address) throw new Error('Informe o endereço de entrega.');
  const notes = String(value?.notes ?? existing?.notes ?? '').trim().slice(0, 1000);
  const rawItems = Array.isArray(value?.itemsJson) ? value.itemsJson : null;
  const itemsJson = rawItems || (existing?.itemsJson && Array.isArray(existing.itemsJson) ? existing.itemsJson : null);
  const items = String(value?.items || existing?.items || '').trim().slice(0, 2500);
  if ((!itemsJson || !itemsJson.length) && !items) throw new Error('Adicione os itens do pedido.');
  const rawAmount = Number(value?.amount ?? existing?.amount ?? 0);
  const rawPaid = Number(value?.paid ?? existing?.paid ?? 0);
  if (!Number.isFinite(rawAmount) || !Number.isFinite(rawPaid)) throw new Error('Confira os valores do pedido.');
  const amount = Math.max(0, Math.min(1_000_000, rawAmount));
  const paid = Math.max(0, Math.min(amount, rawPaid));
  const allowedStages = ['Aguardando confirmação', 'Confirmado', 'Em preparo', 'Pronto', 'Entregue', 'Cancelado'];
  const stage = allowedStages.includes(value?.stage) ? value.stage : (existing?.stage || 'Aguardando confirmação');
  return {
    client, phone, items, itemsJson: itemsJson || [], date, time,
    scheduledAt: scheduledAt.toISOString(), timezone: String(value?.timezone || existing?.timezone || 'America/Sao_Paulo').slice(0, 80),
    delivery, address, notes, amount, paid, stage,
    r24: value?.r24 !== false && existing?.r24 !== false, r12: value?.r12 !== false && existing?.r12 !== false,
    source: existing?.source || String(value?.source || 'app').slice(0, 20)
  };
}

function orderFromDocument(row, id) {
  const createdAt = row.createdAt?.toDate ? row.createdAt.toDate() : new Date(row.createdAt || Date.now());
  const updatedAt = row.updatedAt?.toDate ? row.updatedAt.toDate() : new Date(row.updatedAt || Date.now());
  return {
    id, client: row.client, phone: row.phone, items: row.items,
    itemsJson: Array.isArray(row.itemsJson) ? row.itemsJson : [], date: row.date, time: String(row.time).slice(0, 5),
    scheduledAt: new Date(row.scheduledAt).toISOString(), scheduledAtMillis: new Date(row.scheduledAt).getTime(), timezone: row.timezone,
    delivery: row.delivery, address: row.address, notes: row.notes,
    amount: Number(row.amount), paid: Number(row.paid), stage: row.stage,
    r24: row.r24, r12: row.r12, source: row.source,
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString()
  };
}

async function saveOrderRecord(order, id = crypto.randomUUID()) {
  const collection = database();
  const reference = collection.doc(id);
  const current = await reference.get();
  const now = new Date().toISOString();
  const document = {
    ...order,
    createdAt: current.exists ? current.data().createdAt : now,
    updatedAt: now
  };
  await reference.set(document);
  return orderFromDocument(document, id);
}

async function sendOrderCreatedNotification(order) {
  if (!firebaseMessaging) return;
  const devices = await adminDevices().get();
  const tokens = [...new Set(devices.docs.map((document) => document.data().token).filter(Boolean))].slice(0, 500);
  if (!tokens.length) return;
  const result = await firebaseMessaging.sendEachForMulticast({
    tokens,
    notification: {
      title: 'Novo pedido agendado',
      body: `${order.client} · ${order.date.split('-').reverse().join('/')} às ${order.time}`
    },
    data: { type: 'new_order', orderId: String(order.id) },
    android: { priority: 'high', notification: { channelId: 'nane_orders' } }
  });
  const invalid = [];
  result.responses.forEach((response, index) => {
    if (!response.success && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(response.error?.code)) {
      invalid.push(tokens[index]);
    }
  });
  if (invalid.length) {
    const batch = firestore.batch();
    for (const token of invalid) batch.delete(adminDevices().doc(crypto.createHash('sha256').update(token).digest('hex')));
    await batch.commit();
  }
  if (result.failureCount) console.warn(`FCM notification delivery failed for ${result.failureCount} device(s).`);
}

async function createOrderFromCatalog(body) {
  const client = String(body?.client || '').trim().slice(0, 100);
  const phone = String(body?.phone || '').replace(/[^0-9+]/g, '').slice(0, 20);
  const date = String(body?.date || '').trim();
  const time = String(body?.time || '').trim();
  if (!client) throw new Error('Informe seu nome.');
  if (phone.replace(/\D/g, '').length < 10) throw new Error('Confira o número do WhatsApp.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Confira a data e o horário do pedido.');
  const dateCheck = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== date) throw new Error('A data do pedido não é válida.');
  const scheduledAt = validScheduledAt(body?.scheduledAt);
  const delivery = body?.delivery === 'delivery' ? 'delivery' : 'pickup';
  const address = String(body?.address || '').trim().slice(0, 300);
  if (delivery === 'delivery' && !address) throw new Error('Informe o endereço para entrega.');
  const selected = Array.isArray(body?.items) ? body.items : [];
  if (!selected.length || selected.length > 50) throw new Error('Adicione pelo menos um item ao pedido.');
  const catalog = await loadCatalog();
  const allProducts = [...catalog.products, ...catalog.beverages].filter((item) => item.active !== false);
  const itemsJson = selected.map((selection) => {
    const item = allProducts.find((product) => product.id === String(selection?.id || ''));
    const quantity = Number(selection?.quantity);
    if (!item || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error('Um dos itens escolhidos não está mais disponível. Atualize o cardápio.');
    return { id: item.id, name: item.name, qty: quantity, unit: item.unitLabel || 'unidade', unitPrice: item.price == null ? null : Number(item.price) };
  });
  const amount = itemsJson.reduce((sum, item) => sum + (item.unitPrice == null ? 0 : item.unitPrice * item.qty), 0);
  const items = itemsJson.map((item) => `${item.qty}× ${item.name}${item.unit === 'cento' ? ' (100 salgados)' : ''}`).join(', ');
  const timezone = String(body?.timezone || 'America/Sao_Paulo').slice(0, 80);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(scheduledAt);
    const local = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (`${local.year}-${local.month}-${local.day}` !== date || `${local.hour}:${local.minute}` !== time) throw new Error('A data ou o horário não corresponde ao fuso selecionado.');
  }
  catch { throw new Error('Fuso horário inválido.'); }
  return normalizeOrderInput({
    client, phone, date, time, scheduledAt: scheduledAt.toISOString(), timezone,
    delivery, address, notes: body?.notes, items, itemsJson, amount, paid: 0,
    stage: 'Aguardando confirmação', r24: true, r12: true, source: 'site'
  });
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

app.post('/api/admin/mobile-login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkLoginLimit(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
  try {
    database();
    const expected = required('ADMIN_PASSWORD');
    if (!safeEqual(req.body?.password || '', expected)) return res.status(401).json({ error: 'Senha incorreta.' });
    const lifetime = 30 * 24 * 60 * 60 * 1000;
    res.set('Cache-Control', 'no-store').json({ token: createToken(lifetime), expiresIn: lifetime / 1000 });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status ? error.message : 'O banco da agenda não está disponível.' });
  }
});

app.post('/api/admin/mobile-pairing', requireAdmin, async (_req, res) => {
  try {
    const code = String(crypto.randomInt(10_000_000, 100_000_000));
    const createdAt = Date.now();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    await mobilePairings().doc(codeHash).create({ createdAt, expiresAt: createdAt + 10 * 60 * 1000 });
    res.set('Cache-Control', 'no-store').json({ code, expiresAt: createdAt + 10 * 60 * 1000 });
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status ? error.message : 'Não foi possível gerar o código do aplicativo.' });
  }
});

app.post('/api/admin/mobile-pairing/redeem', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!checkLoginLimit(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
  const code = String(req.body?.code || '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(code)) return res.status(400).json({ error: 'Digite o código de 8 números gerado no painel.' });
  try {
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const reference = mobilePairings().doc(codeHash);
    const result = await firestore.runTransaction(async (transaction) => {
      const pairing = await transaction.get(reference);
      if (!pairing.exists || pairing.data().expiresAt <= Date.now()) return null;
      transaction.delete(reference);
      const lifetime = 30 * 24 * 60 * 60 * 1000;
      return { token: createToken(lifetime), expiresIn: lifetime / 1000 };
    });
    if (!result) return res.status(401).json({ error: 'Código inválido ou expirado. Gere outro no painel.' });
    res.set('Cache-Control', 'no-store').json(result);
  } catch (error) {
    res.status(error.status || 503).json({ error: error.status ? error.message : 'Não foi possível conectar o aplicativo à agenda.' });
  }
});

app.post('/api/orders', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!limitPublicOrder(ip)) return res.status(429).json({ error: 'Muitos pedidos enviados. Aguarde alguns minutos e tente novamente.' });
  // Honeypot used to silently discard basic automated form submissions.
  if (String(req.body?.website || '').trim()) return res.status(201).json({ ok: true, id: 'received' });
  try {
    const order = await createOrderFromCatalog(req.body);
    const saved = await saveOrderRecord(order);
    try { await sendOrderCreatedNotification(saved); }
    catch (error) { console.error('New-order notification failed:', error.message); }
    res.status(201).set('Cache-Control', 'no-store').json({ ok: true, id: saved.id, stage: saved.stage });
  } catch (error) {
    console.error('Public order create failed:', error.message);
    res.status(error.status || 400).json({ error: error.message || 'Não foi possível registrar o pedido.' });
  }
});

app.get('/api/admin/catalog', requireAdmin, async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store').json(await loadCatalog());
  } catch (error) {
    console.error('Admin catalog read failed:', error.message);
    res.status(503).json({ error: 'Não foi possível abrir o catálogo do GitHub.' });
  }
});

app.get('/api/admin/orders', requireAdmin, async (_req, res) => {
  try {
    const result = await database().orderBy('scheduledAt', 'asc').limit(2000).get();
    res.set('Cache-Control', 'no-store').json({ orders: result.docs.map((document) => orderFromDocument(document.data(), document.id)) });
  } catch (error) {
    console.error('Orders read failed:', error.message);
    res.status(error.status || 503).json({ error: 'Não foi possível carregar os pedidos da agenda.' });
  }
});

app.put('/api/admin/orders', requireAdmin, async (req, res) => {
  const input = Array.isArray(req.body?.orders) ? req.body.orders : [];
  if (input.length > 1000) return res.status(413).json({ error: 'Há pedidos demais para sincronizar de uma vez.' });
  try {
    const saved = [];
    for (const item of input) {
      const normalized = normalizeOrderInput(item, item);
      const id = String(item.id || crypto.randomUUID()).slice(0, 80);
      if (!id || id.includes('/')) throw new Error('Um pedido tem um identificador inválido.');
      saved.push(await saveOrderRecord(normalized, id));
    }
    res.set('Cache-Control', 'no-store').json({ ok: true, orders: saved });
  } catch (error) {
    console.error('Order sync failed:', error.message);
    res.status(error.status || 400).json({ error: error.message || 'Não foi possível sincronizar os pedidos.' });
  }
});

app.put('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id).slice(0, 80);
    const current = await database().doc(id).get();
    if (!current.exists) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const normalized = normalizeOrderInput(req.body, { ...current.data(), id: current.id });
    const saved = await saveOrderRecord(normalized, current.id);
    res.set('Cache-Control', 'no-store').json({ ok: true, order: saved });
  } catch (error) {
    console.error('Order update failed:', error.message);
    res.status(error.status || 400).json({ error: error.message || 'Não foi possível atualizar o pedido.' });
  }
});

app.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const reference = database().doc(String(req.params.id).slice(0, 80));
    const current = await reference.get();
    if (!current.exists) return res.status(404).json({ error: 'Pedido não encontrado.' });
    await reference.delete();
    res.json({ ok: true });
  } catch (error) {
    console.error('Order delete failed:', error.message);
    res.status(error.status || 503).json({ error: 'Não foi possível excluir o pedido.' });
  }
});

app.put('/api/admin/device-token', requireAdmin, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (token.length < 40 || token.length > 4096) return res.status(400).json({ error: 'Token de notificação inválido.' });
  try {
    const tokenId = crypto.createHash('sha256').update(token).digest('hex');
    await adminDevices().doc(tokenId).set({ token, platform: 'android', updatedAt: new Date().toISOString() }, { merge: true });
    res.set('Cache-Control', 'no-store').json({ ok: true });
  } catch (error) {
    console.error('Device registration failed:', error.message);
    res.status(error.status || 503).json({ error: 'Não foi possível registrar este aparelho para notificações.' });
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

async function start() {
  app.listen(port, '0.0.0.0', () => console.log(`Nane catalog API listening on ${port}`));
}

start().catch((error) => {
  console.error('API startup failed:', error.message);
  process.exit(1);
});
