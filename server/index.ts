// Le pont entre le bureau et Claude Code. Il sert le bureau (dossier dist/) et ouvre une connexion
// WebSocket sur /ws. Il n'écoute que sur ton ordinateur (127.0.0.1), et refuse toute page qui ne vient
// pas du bureau lui-même : un site web ne peut pas lancer ton équipe à ta place.
//
//   node server/index.ts            le bureau sur http://localhost:4848
//   node server/index.ts --open     … et l'ouvre dans le navigateur
//   node server/index.ts --dev      seulement le pont (le bureau est servi par Vite, port 5174)
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../shared/protocol.ts';
import { Bureau } from './bureau.ts';
import { findClaude } from './claude.ts';
import { allowedHosts, hostAllowed, safeDecode } from './surete.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const PORT = Number(process.env.PORT ?? 4848);
const HOST = '127.0.0.1';
const DEV_PORT = 5174;
// Jeton de session : tiré au hasard à chaque démarrage, glissé dans la page servie (meta « bureau-token »), exigé pour
// ouvrir la connexion /ws. Un autre programme de l'ordinateur qui n'a pas chargé la page ne peut pas piloter l'équipe.
// En développement (--dev), la page vient de Vite : pas de jeton (la connexion reste limitée par Origin et Host).
const TOKEN = randomBytes(24).toString('hex');
const tokenOk = (t: string | null) => {
  if (DEV) return true;
  if (!t || t.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
};

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "media-src 'self' blob: data:", "worker-src 'self' blob:",
  `connect-src 'self' ws://localhost:${PORT} ws://127.0.0.1:${PORT}`, "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

// L'aperçu des sites faits par l'équipe : servis à part, dans un bac à sable (origine opaque) :
// leurs scripts tournent, mais ils ne peuvent ni lire le bureau, ni se connecter au pont.
const PREVIEW_CSP = [
  'sandbox allow-scripts allow-forms allow-popups allow-modals', "default-src 'none'", "img-src 'self' data: blob:", "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline'", "font-src 'self' data:", "connect-src 'none'",
  "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
].join('; ');

const claude = await findClaude();
// la version du bureau compilé : un onglet resté ouvert se recharge quand elle change
const BUILD = (() => { try { return String(Math.round(statSync(path.join(DIST, 'index.html')).mtimeMs)); } catch { return 'dev'; } })();
const clients = new Set<WebSocket>();

function broadcast(m: ServerMsg) {
  const s = JSON.stringify(m);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
}

const bureau = new Bureau(claude, broadcast, process.env.BUREAU_DIR);
await bureau.init();

// ── Le serveur web (le bureau compilé) ──
// Seuls « localhost:PORT » et « 127.0.0.1:PORT » sont acceptés comme nom d'hôte (et ceux de Vite en développement) :
// une page piégée qui ferait pointer son nom de domaine vers 127.0.0.1 (DNS rebinding) n'obtient rien.
const hosts = allowedHosts(PORT, DEV ? DEV_PORT : undefined);

const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host, hosts)) { res.writeHead(403).end(); return; }
  const url0 = new URL(req.url ?? '/', 'http://x');
  if (url0.pathname.startsWith('/apercu/')) { await preview(url0, res); return; }
  if (DEV) { res.writeHead(404).end(`Mode développement : le bureau est sur http://localhost:${DEV_PORT}`); return; }
  try {
    const url = url0;
    const decoded = safeDecode(url.pathname);
    if (decoded === null) { res.writeHead(400).end(); return; }
    let file = path.normalize(path.join(DIST, decoded));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || file === DIST || file.endsWith(path.sep)) file = path.join(DIST, 'index.html');
    let body: Buffer | string = await readFile(file);
    const ext = path.extname(file);
    if (ext === '.html') body = body.toString('utf8').replace('<meta name="bureau-token" content="" />', `<meta name="bureau-token" content="${TOKEN}" />`);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      // aucun script venu d'ailleurs : même un lien piégé dans un rapport ne peut rien exécuter
      ...(ext === '.html' ? { 'Content-Security-Policy': CSP } : {}),
    });
    res.end(body);
  } catch {
    res.writeHead(500).end('Le bureau n’est pas compilé : lance « npm start ».');
  }
});

/** /apercu/<mission>/<chemin> : un fichier de la mission, dans le bac à sable. */
async function preview(url: URL, res: http.ServerResponse) {
  try {
    const parts = url.pathname.split('/').slice(2).map((p) => safeDecode(p));
    if (parts.some((p) => p === null)) { res.writeHead(400, { 'Content-Security-Policy': PREVIEW_CSP }).end(); return; }
    const missionId = parts.shift() ?? '';
    let rel = (parts as string[]).join('/');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = await bureau.previewPath(missionId, rel);
    if (!file) { res.writeHead(404, { 'Content-Security-Policy': PREVIEW_CSP }).end('Introuvable dans le dossier de la mission.'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Security-Policy': PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(500, { 'Content-Security-Policy': PREVIEW_CSP }).end();
  }
}

// ── La connexion avec le bureau ──
// Seul le bureau lui-même peut se connecter (et, en développement, la page servie par Vite).
const allowedOrigins = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, ...(DEV ? [`http://localhost:${DEV_PORT}`, `http://127.0.0.1:${DEV_PORT}`] : [])]);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin ?? '';
  const wsUrl = new URL(req.url ?? '/', 'http://x');
  if (wsUrl.pathname !== '/ws' || !tokenOk(wsUrl.searchParams.get('t')) || !allowedOrigins.has(origin) || !hostAllowed(req.headers.host, hosts)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  const send = (m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  // sans ce listener, un message trop gros (> maxPayload) ou une trame invalide ferait tomber tout le serveur
  ws.on('error', (e) => {
    if (process.env.BUREAU_DEBUG) console.error('  ⚠  Connexion du bureau en erreur :', e.message);
    try { send({ t: 'toast', kind: 'error', text: 'Ce message est trop gros pour le bureau.' }); } catch { /* connexion déjà fermée */ }
    clients.delete(ws);
  });
  send({ ...bureau.hello(), build: BUILD } as ServerMsg);
  ws.on('message', async (data) => {
    let m: ClientMsg;
    try { m = JSON.parse(String(data)); } catch { if (process.env.BUREAU_DEBUG) console.error('  ⚠  Message du bureau illisible (JSON invalide).'); return; }
    try {
      await handle(m, send);
    } catch (e) {
      send({ t: 'toast', kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  });
});

const str = (v: unknown, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : '');

async function handle(m: ClientMsg, send: (m: ServerMsg) => void) {
  switch (m.t) {
    case 'start':
      await bureau.start(str(m.prompt));
      break;
    case 'say':
      bureau.say(str(m.text));
      break;
    case 'stop':
      bureau.stop();
      break;
    case 'answer':
      bureau.answer(str(m.requestId, 100), m.allow === true);
      break;
    case 'new':
      bureau.close();
      break;
    case 'open':
      await bureau.open(str(m.missionId, 40), m.file ? str(m.file, 1000) : undefined);
      break;
    case 'open_root':
      bureau.openRoot(m.rules === true);
      break;
    case 'read': {
      const file = str(m.file, 1000);
      const version = m.version ? str(m.version, 120) : undefined;
      const { text, truncated } = await bureau.readText(str(m.missionId, 40), file, version);
      send({ t: 'file_text', missionId: m.missionId, file, text, truncated, version });
      break;
    }
    case 'versions': {
      const file = str(m.file, 1000);
      send({ t: 'versions', missionId: m.missionId, file, list: await bureau.versions(str(m.missionId, 40), file) });
      break;
    }
    case 'team_history':
      send({ t: 'team_history', entries: await bureau.teamHistory() });
      break;
    case 'replay': {
      const { mission, log } = await bureau.replay(str(m.missionId, 40));
      send({ t: 'replay', mission, log });
      break;
    }
    case 'settings':
      bureau.setSettings(m.settings ?? {});
      break;
  }
}

function listen(port: number) {
  server.once('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`  Le port ${port} est déjà pris : le bureau tourne peut-être déjà (http://localhost:${port}).`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, HOST, () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  🏢  Le Bureau des agents');
    console.log(`  ➜  ${DEV ? `Pont prêt (le bureau : http://localhost:${DEV_PORT})` : url}`);
    console.log(`  📁  Les missions : ${bureau.missionsDir}`);
    console.log(claude ? `  ✓  Claude Code ${claude.version} (${claude.path})` : '  ✗  Claude Code introuvable : le bureau tournera en démo.');
    console.log('  ⏹  Pour arrêter : Ctrl + C');
    console.log('');
    if (args.has('--open') && !DEV) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      execFile(opener, [url], () => {});
    }
  });
}

listen(PORT);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(0); // un second Ctrl + C : on n’attend plus
    stopping = true;
    // on laisse 2,5 s aux processus claude pour partir (SIGTERM, puis SIGKILL après 2 s)
    void Promise.race([bureau.shutdown(), new Promise((r) => setTimeout(r, 2500))]).then(() => process.exit(0));
  });
}
