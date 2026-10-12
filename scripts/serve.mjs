#!/usr/bin/env node
// Zero-dependency static server for the built app (dist/). Listens on $PORT (default 8080).
// Used by `npm start` and the Docker image.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(process.env.DIST_DIR || 'dist');
const port = Number(process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const gzCache = new Map();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    let st = await stat(file).catch(() => null);
    if (st?.isDirectory()) { file = join(file, 'index.html'); st = await stat(file).catch(() => null); }
    if (!st) { file = join(root, 'index.html'); } // SPA fallback (routes are hash-based anyway)
    const ext = extname(file);
    const type = types[ext] || 'application/octet-stream';
    const headers = {
      'content-type': type,
      'cache-control': file.includes(`${join(root, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    };
    let body = await readFile(file);
    if (/text|json|svg/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      if (!gzCache.has(file)) gzCache.set(file, gzipSync(body));
      body = gzCache.get(file);
      headers['content-encoding'] = 'gzip';
      headers['vary'] = 'Accept-Encoding';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500); res.end('Internal error');
    console.error(e);
  }
}).listen(port, '0.0.0.0', () => console.log(`Serving ${root} on http://0.0.0.0:${port}`));
