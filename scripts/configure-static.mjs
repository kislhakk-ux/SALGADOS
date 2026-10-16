import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiUrl = String(process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
const config = `window.NANE_CONFIG = ${JSON.stringify({ API_BASE_URL: apiUrl })};\n`;
await fs.writeFile(path.join(root, 'site-config.js'), config, 'utf8');
console.log(`Storefront configured${apiUrl ? ` for ${apiUrl}` : ' without API URL'}.`);
