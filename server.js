#!/usr/bin/env node
// Minimal zero-dependency server: serves the app and persists db.json to disk
// so every browser/device that connects shares the same live data.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

function readDB() {
  try { return fs.readFileSync(DB_FILE, 'utf8'); }
  catch (e) { return null; }
}

function writeDB(body) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, DB_FILE);
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/db' && req.method === 'GET') {
    const data = readDB();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data || 'null');
    return;
  }

  if (req.url === '/api/db' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        parsed._updatedAt = Date.now();
        writeDB(JSON.stringify(parsed));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, updatedAt: parsed._updatedAt }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Static file serving (index.html and anything else in this directory)
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(urlPath)));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`A&D Precision ERP server running on http://0.0.0.0:${PORT}`);
  console.log(`Shared data file: ${DB_FILE}`);
});
