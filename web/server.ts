import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ReviewService, type ReviewConfig } from '../runner/review.ts';
const publicRoot = new URL('./public/', import.meta.url);
export async function startServer(config: ReviewConfig, port = 4318) {
  const service = new ReviewService(config), token = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const address = server.address(); const actualPort = address && typeof address !== 'string' ? address.port : port;
    const origin = `http://127.0.0.1:${actualPort}`;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== `127.0.0.1:${actualPort}` || (req.headers.origin && req.headers.origin !== origin)) { json(403, { error: 'Local origin required.' }); return; }
      const path = new URL(req.url ?? '/', origin).pathname;
      if (path.startsWith('/api/')) {
        const supplied = req.headers['x-codeboost-token'];
        if (typeof supplied !== 'string' || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { json(403, { error: 'Open the private local URL printed by the CLI.' }); return; }
        if (req.method === 'GET' && path === '/api/review') { json(200, service.load()); return; }
        if (req.method !== 'POST' || path !== '/api/action' || req.headers['content-type'] !== 'application/json') { json(405, { error: 'Unsupported request.' }); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) { json(413, { error: 'Request too large.' }); return; } chunks.push(chunk); }
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        json(200, service.act(JSON.parse(body))); return;
      }
      if (req.method !== 'GET') { json(405, { error: 'Method not allowed.' }); return; }
      const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const file = files[path];
      if (file) { res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(readFileSync(new URL(file[0], publicRoot))); return; }
      const font = /^\/fonts\/(ibm-plex-(?:sans|mono)-latin-(?:400|500|600)-normal\.woff2)$/.exec(path);
      if (font) {
        const family = font[1]!.startsWith('ibm-plex-sans') ? 'ibm-plex-sans' : 'ibm-plex-mono';
        res.writeHead(200, { 'Content-Type': 'font/woff2' }); res.end(readFileSync(fileURLToPath(new URL(`../node_modules/@fontsource/${family}/files/${font[1]}`, import.meta.url)))); return;
      }
      json(404, { error: 'Not found.' });
    } catch (error) { json(409, { error: error instanceof Error ? error.message : 'Review failed.' }); }
  });
  server.requestTimeout = 15000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }).catch(error => { service.close(); throw error; });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Cannot determine local address.');
  return { server, service, token, url: `http://127.0.0.1:${address.port}/#${token}`, close: () => new Promise<void>((resolve, reject) => server.close(error => { service.close(); error ? reject(error) : resolve(); })) };
}
