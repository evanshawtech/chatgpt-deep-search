import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = 4173;

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const file = url.pathname === '/' || url.pathname.startsWith('/c/') ? 'index.html' : url.pathname.slice(1);
  try {
    const body = await readFile(path.join(root, file));
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Mock ChatGPT running at http://127.0.0.1:${port}`);
});
