#!/usr/bin/env node
// Server for the A&D Precision ERP app.
//   - Serves the static app
//   - Persists the shared database to disk (data/db.json)
//   - Merges concurrent saves at the per-record level instead of blindly
//     overwriting, so two people adding/editing different records at the
//     same time don't wipe each other out
//   - Requires a shared site key on every /api/db request so the data isn't
//     wide open to anyone who finds the server's address
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BAK_FILE = path.join(DATA_DIR, 'db.json.bak');
const KEY_FILE = path.join(DATA_DIR, 'site.key');
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25MB — generous for a JSON db dump, rejects anything absurd

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Site key: protects /api/db from anyone who isn't on the team ──
// Generated once and stored on disk so it survives restarts. Override by
// setting SITE_KEY in the environment before first run.
function getSiteKey() {
  if (process.env.SITE_KEY) return process.env.SITE_KEY;
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); }
  catch (e) {
    const key = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(KEY_FILE, key);
    return key;
  }
}
const SITE_KEY = getSiteKey();
console.log('Site access key (share this with your team, they enter it once per browser):');
console.log('  ' + SITE_KEY);

// ── Per-table primary-key fields, used to merge concurrent saves ──
const KEY_FIELDS = {
  customers: 'code', suppliers: 'code', material: 'ref', stock: 'code',
  tools: 'id', programs: 'num', parts: 'pn',
  orders: 'id', pos: 'id', dns: 'id', ncrs: 'id',
  isoDocs: 'ref', gauges: 'id', machines: 'name',
  finishedParts: 'id', holidays: 'id', pm: 'id', rfqs: 'id', coolantChecks: 'id',
  coolantProducts: 'code', messages: 'id', stockCheckouts: 'id',
};
// Append-only log tables with no natural unique key — unioned and de-duped instead
const LOG_TABLES = ['timeLogs', 'staging', 'scrapLog', 'sparesStock', 'stockUsage'];

function mergeTable(name, serverRows, incomingRows) {
  serverRows = serverRows || [];
  incomingRows = incomingRows || [];
  const key = KEY_FIELDS[name];
  if (key) {
    const byKey = new Map();
    serverRows.forEach(r => { if (r && r[key] != null) byKey.set(r[key], r); });
    // Incoming (the save that's landing now) wins on a genuine same-record conflict,
    // but anything that only exists on the server side (added by someone else) survives.
    incomingRows.forEach(r => {
      if (r == null || r[key] == null) return;
      // Messages/orders/POs/DNs: readBy is a per-viewer list, mutated independently by
      // whoever opens that record. Last-write-wins would let one viewer's save erase
      // another viewer's entry, so union the two lists instead of blindly overwriting.
      if ((name === 'messages' || name === 'orders' || name === 'pos' || name === 'dns') && Array.isArray(r.readBy)) {
        const existing = byKey.get(r[key]);
        if (existing && Array.isArray(existing.readBy)) {
          r = { ...r, readBy: Array.from(new Set([...existing.readBy, ...r.readBy])) };
        }
      }
      byKey.set(r[key], r);
    });
    return Array.from(byKey.values());
  }
  if (LOG_TABLES.includes(name)) {
    const seen = new Set();
    const out = [];
    [...serverRows, ...incomingRows].forEach(r => {
      const sig = JSON.stringify(r);
      if (!seen.has(sig)) { seen.add(sig); out.push(r); }
    });
    return out;
  }
  // Unknown shape — safest is to keep whatever just arrived
  return incomingRows;
}

function mergeDB(serverDB, incomingDB) {
  if (!serverDB) return incomingDB;
  const merged = { ...incomingDB };
  const tables = new Set([...Object.keys(serverDB), ...Object.keys(incomingDB)]);
  tables.forEach(name => {
    if (name === 'settings' || name === '_updatedAt' || name === '_users') return;
    if (Array.isArray(incomingDB[name]) || Array.isArray(serverDB[name])) {
      merged[name] = mergeTable(name, serverDB[name], incomingDB[name]);
    }
  });
  // Settings + the user-account list: most recent save wins outright (rarely conflicts)
  merged.settings = incomingDB.settings || serverDB.settings;
  merged._users = incomingDB._users || serverDB._users;
  return merged;
}

// ── Disk access, serialized so concurrent saves can't corrupt the file ──
let writeQueue = Promise.resolve();
function readDBSync() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return null; }
}
function writeDB(obj) {
  writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
    try {
      if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, BAK_FILE); // crash-recovery snapshot
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, DB_FILE);
      resolve();
    } catch (e) { reject(e); }
  }));
  return writeQueue;
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

function checkAuth(req) {
  const header = req.headers['x-site-key'] || '';
  return header === SITE_KEY;
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/db' && req.method === 'GET') {
    if (!checkAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Invalid or missing site key"}'); return; }
    const data = readDBSync();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (req.url === '/api/db' && req.method === 'POST') {
    if (!checkAuth(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Invalid or missing site key"}'); return; }
    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooBig = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"Payload too large"}');
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let incoming;
      try { incoming = JSON.parse(body); }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"Invalid JSON"}'); return; }
      try {
        const current = readDBSync();
        const merged = mergeDB(current, incoming);
        merged._updatedAt = Date.now();
        await writeDB(merged);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(merged));
      } catch (e) {
        console.error('Failed to save db:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"Server failed to save"}');
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

// Don't let one bad request or unexpected error take the whole server down
process.on('uncaughtException', err => console.error('Uncaught exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

server.listen(PORT, () => {
  console.log(`A&D Precision ERP server running on http://0.0.0.0:${PORT}`);
  console.log(`Shared data file: ${DB_FILE}`);
});
