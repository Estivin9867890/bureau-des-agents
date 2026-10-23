// Tests d'une vraie instance du serveur (port 4999, dossier temporaire, aucune mission claude lancée).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';

const PORT = 4999;
let proc;
let out = '';

const get = (host, url = '/') => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: url, headers: { Host: host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
});

before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bureau-srv-'));
  // CLAUDE_BIN vide et PATH réduit : le serveur démarre en démo, sans jamais lancer claude
  proc = spawn(process.execPath, ['server/index.ts'], { env: { PATH: '/nonexistent', HOME: dir, PORT: String(PORT), BUREAU_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (b) => { out += b; });
  proc.stderr.on('data', (b) => { out += b; });
  for (let i = 0; i < 100 && !out.includes('Pour arrêter'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('Pour arrêter'), out);
});
after(() => proc?.kill('SIGKILL'));

test('Host correct : 200 ; Host forgé : 403', async () => {
  assert.equal(await get(`localhost:${PORT}`), 200);
  assert.equal(await get(`127.0.0.1:${PORT}`), 200);
  assert.equal(await get('evil.com'), 403);
  assert.equal(await get(`evil.com:${PORT}`), 403);
  assert.equal(await get(`localhost:${PORT}`, '/%E0%A4%A'), 400);
  assert.equal(await get('evil.com', '/apercu/x/index.html'), 403);
});

// le jeton de session : le serveur le glisse dans la page qu'il sert (meta « bureau-token »)
const jeton = () => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
    let h = '';
    res.on('data', (b) => { h += b; });
    res.on('end', () => resolve(/<meta name="bureau-token" content="([0-9a-f]+)"/.exec(h)?.[1]));
  }).on('error', reject);
});

const ouvre = async (headers, token) => new Promise(async (resolve) => {
  const t = token === undefined ? await jeton() : token;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${t ? `?t=${t}` : ''}`, { headers });
  ws.on('open', () => resolve({ ws, status: 101 }));
  ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode }));
  ws.on('error', () => {});
});

test('WebSocket : Host forgé -> 403 ; Host et Origin corrects -> ouvert', async () => {
  const bad = await ouvre({ Origin: `http://localhost:${PORT}`, Host: 'evil.com' });
  assert.equal(bad.status, 403);
  const ok = await ouvre({ Origin: `http://localhost:${PORT}` });
  assert.equal(ok.status, 101);
  ok.ws.close();
});

test('WebSocket : sans jeton ou avec un mauvais -> 403 ; avec le jeton de la page -> ouvert', async () => {
  const t = await jeton();
  assert.match(t ?? '', /^[0-9a-f]{48}$/);
  assert.equal((await ouvre({ Origin: `http://localhost:${PORT}` }, '')).status, 403);
  assert.equal((await ouvre({ Origin: `http://localhost:${PORT}` }, 'a'.repeat(48))).status, 403);
  const ok = await ouvre({ Origin: `http://localhost:${PORT}` }, t);
  assert.equal(ok.status, 101);
  ok.ws.close();
});

test('un message WebSocket de 2 Mo ne tue pas le serveur', async () => {
  const { ws, status } = await ouvre({ Origin: `http://localhost:${PORT}` });
  assert.equal(status, 101);
  await new Promise((r) => { ws.on('close', r); ws.send('x'.repeat(2_000_000)); });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(proc.exitCode, null, out);
  assert.equal(await get(`localhost:${PORT}`), 200);
});
