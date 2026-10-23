// Tests des règles de sécurité du pont (fonctions pures) : node --test tests/
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Bureau, newMissionId } from '../server/bureau.ts';
import { allowedHosts, claudeNames, hostAllowed, launchSpec, openCommand, realInside, safeDecode, safeEnv, trimUtf8 } from '../server/surete.ts';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'bureau-test-'));

test('Host : seuls localhost:PORT et 127.0.0.1:PORT passent', () => {
  const h = allowedHosts(4999);
  assert.ok(hostAllowed('localhost:4999', h));
  assert.ok(hostAllowed('127.0.0.1:4999', h));
  assert.ok(hostAllowed('LOCALHOST:4999', h));
  for (const bad of ['evil.com', 'evil.com:4999', 'localhost', 'localhost:80', '127.0.0.1.evil.com:4999', '', undefined]) assert.ok(!hostAllowed(bad, h), String(bad));
  assert.ok(!hostAllowed('localhost:5174', h));
  assert.ok(hostAllowed('localhost:5174', allowedHosts(4999, 5174)));
});

test('decodeURIComponent protégé', () => {
  assert.equal(safeDecode('%E9a'), null);
  assert.equal(safeDecode('a%20b'), 'a b');
});

test('open : un .command / .app / .sh n’est jamais exécuté, il est révélé', () => {
  for (const f of ['/m/x.command', '/m/x.app', '/m/x.sh', '/m/x.terminal', '/m/x.webloc', '/m/x']) {
    assert.deepEqual(openCommand(f, false, 'darwin'), { cmd: 'open', args: ['-R', f] }, f);
  }
  assert.deepEqual(openCommand('/m/dossier', true, 'darwin'), { cmd: 'open', args: ['-R', '/m/dossier'] });
  // html, htm, svg : exécutables dans le navigateur, donc seulement révélés
  for (const f of ['/m/Page.HTML', '/m/a.htm', '/m/a.svg']) assert.deepEqual(openCommand(f, false, 'darwin'), { cmd: 'open', args: ['-R', f] }, f);
  assert.deepEqual(openCommand('C:\\m\\x.bat', false, 'win32'), { cmd: 'explorer', args: ['/select,C:\\m\\x.bat'] });
  assert.deepEqual(openCommand('/m/x.sh', false, 'linux'), { cmd: 'xdg-open', args: ['/m'] });
  for (const ext of ['md', 'txt', 'csv', 'json', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'mp4']) {
    assert.deepEqual(openCommand(`/m/a.${ext}`, false, 'darwin'), { cmd: 'open', args: [`/m/a.${ext}`] });
  }
});

test('environnement de claude : liste blanche', () => {
  const env = safeEnv({
    PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'fr', LC_ALL: 'C', TERM: 'x', CLAUDE_BIN: '/c', ANTHROPIC_API_KEY: 'k',
    AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 't', NPM_TOKEN: 'n', OPENAI_API_KEY: 'o', SSH_AUTH_SOCK: '/s',
  }, 'darwin');
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_BIN', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'USER']);
});

test('ids de mission aléatoires', () => {
  const ids = new Set(Array.from({ length: 1000 }, newMissionId));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^m[0-9a-f]{24}$/);
});

test('realInside : un lien symbolique sortant est refusé', async () => {
  const root = await tmp();
  const folder = path.join(root, 'mission');
  const dehors = path.join(root, 'secret.txt');
  await mkdir(path.join(folder, 'sous'), { recursive: true });
  await writeFile(dehors, 'secret');
  await writeFile(path.join(folder, 'ok.md'), 'ok');
  await symlink(dehors, path.join(folder, 'lien.txt'));
  await symlink(root, path.join(folder, 'sous', 'racine'));
  assert.ok(await realInside(folder, 'ok.md'));
  assert.equal(await realInside(folder, 'lien.txt'), null);
  assert.equal(await realInside(folder, 'sous/racine/secret.txt'), null);
  assert.equal(await realInside(folder, '../secret.txt'), null);
  assert.equal(await realInside(folder, 'absent.md'), null);
});

test('trimUtf8 ne coupe pas un caractère', () => {
  const b = Buffer.from('aé€😀', 'utf8'); // 1 + 2 + 3 + 4 octets
  for (let n = 0; n <= b.length; n++) {
    const t = trimUtf8(b.subarray(0, n)).toString('utf8');
    assert.ok(!t.includes('\ufffd'), `coupe à ${n}`);
  }
  assert.equal(trimUtf8(b).toString('utf8'), 'aé€😀');
});

test('Windows : claude.exe / claude.cmd', () => {
  assert.deepEqual(claudeNames('linux'), ['claude']);
  assert.deepEqual(claudeNames('win32', '.COM;.EXE;.BAT;.CMD'), ['claude', 'claude.exe', 'claude.cmd']);
  assert.deepEqual(launchSpec('C:\\x\\claude.exe', ['-p'], 'win32'), { cmd: 'C:\\x\\claude.exe', args: ['-p'] });
  assert.deepEqual(launchSpec('/bin/claude', ['-p'], 'linux'), { cmd: '/bin/claude', args: ['-p'] });
  assert.throws(() => launchSpec('C:\\npm\\claude.cmd', ['-p'], 'win32', () => false), /claude\.exe/);
  const ok = launchSpec('C:\\npm\\claude.cmd', ['-p'], 'win32', (f) => f.endsWith('claude.exe'));
  assert.ok(ok.cmd.endsWith('claude.exe'));
});

test('state.json corrompu : copie gardée avant de repartir à vide', async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, '.bureau'), { recursive: true });
  await writeFile(path.join(dir, '.bureau', 'state.json'), '{pas du json');
  const b = new Bureau(null, () => {}, dir);
  await b.init();
  const files = await readdir(path.join(dir, '.bureau'));
  const copie = files.find((f) => f.startsWith('state.json.corrompu-'));
  assert.ok(copie, files.join(','));
  assert.equal(await readFile(path.join(dir, '.bureau', copie), 'utf8'), '{pas du json');
  assert.ok(!files.includes('state.json'));
  assert.equal(b.settings.permission, 'ask');
});

test('readText : 400 ko au plus, sans caractère coupé ; symlink sortant refusé ; ancien id lisible', async () => {
  const dir = await tmp();
  const b = new Bureau(null, () => {}, dir);
  await b.init();
  const folder = path.join(dir, 'Missions', 'm1');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'gros.txt'), '€'.repeat(300_000)); // 900 000 octets
  await writeFile(path.join(dir, 'secret.txt'), 'secret');
  await symlink(path.join(dir, 'secret.txt'), path.join(folder, 'lien.txt'));
  // un ancien identifiant (m + date en base 36) reste valable
  b['state'].missions.push({ id: 'mlx1abc2', title: 't', prompt: 'p', folder, createdAt: 1, workMs: 0, status: 'done', stats: {}, files: [] });
  const r = await b.readText('mlx1abc2', 'gros.txt');
  assert.ok(r.truncated);
  assert.ok(!r.text.includes('\ufffd'));
  assert.ok(Buffer.byteLength(r.text) <= 400_000);
  await assert.rejects(b.readText('mlx1abc2', 'lien.txt'), /pas dans le dossier/);
  await assert.rejects(b.readText('mlx1abc2', '../secret.txt'), /pas dans le dossier/);
  assert.equal(await b.previewPath('mlx1abc2', 'lien.txt'), null);
  assert.ok(await b.previewPath('mlx1abc2', 'gros.txt'));
});

test('start : un second départ rapproché est refusé (verrou synchrone)', async () => {
  const dir = await tmp();
  const b = new Bureau({ path: '/bin/echo', version: 'test' }, () => {}, dir);
  await b.init();
  // spawn est remplacé : on ne lance aucun vrai processus claude
  b['spawn'] = () => ({ proc: { send() {}, alive: true, stop() {}, kill: async () => {} }, norm: { present: new Set() }, stopping: false, lastText: '', resumed: false });
  const res = await Promise.allSettled([b.start('Première mission'), b.start('Seconde mission')]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(res.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(b['state'].missions.length, 1);
  b.close();
});
