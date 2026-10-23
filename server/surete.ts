// Les petites règles de sécurité du pont, réunies ici pour pouvoir les tester une par une
// (aucun effet de bord : rien ici ne lance de processus ni n'ouvre de port).
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

// ── Le nom d'hôte (contre le DNS rebinding) ──

/** Les valeurs d'en-tête « Host » acceptées : seulement le bureau lui-même (et Vite en développement). */
export function allowedHosts(port: number, devPort?: number): Set<string> {
  const ports = devPort ? [port, devPort] : [port];
  return new Set(ports.flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`]));
}

export const hostAllowed = (host: string | undefined, allowed: Set<string>) => allowed.has((host ?? '').toLowerCase());

/** decodeURIComponent qui renvoie null au lieu de lever sur une URL mal encodée. */
export function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

// ── Les chemins (liens symboliques compris) ──

/**
 * Le vrai chemin d'un fichier du dossier `folder`, ou null s'il n'existe pas ou s'il en sort
 * (un lien symbolique qui pointe ailleurs est refusé). `rel` vide = le dossier lui-même.
 */
export async function realInside(folder: string, rel: string): Promise<string | null> {
  try {
    const root = await realpath(folder);
    const target = await realpath(path.resolve(folder, rel));
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    return target;
  } catch { return null; }
}

// ── Ouvrir un fichier : jamais l'exécuter ──

/** Les seuls types de fichiers ouverts avec l'appli par défaut. Tout le reste est seulement montré dans le Finder. */
export const OPENABLE = new Set(['md', 'txt', 'csv', 'json', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'mp4']);

export interface Launch { cmd: string; args: string[] }

/** Ce qu'on lance pour « ouvrir » : l'appli par défaut pour un fichier sûr, sinon on le révèle dans le gestionnaire de fichiers. */
export function openCommand(target: string, isDir: boolean, platform: NodeJS.Platform = process.platform): Launch {
  const ext = path.extname(target).slice(1).toLowerCase();
  const safe = !isDir && OPENABLE.has(ext);
  if (platform === 'darwin') return { cmd: 'open', args: safe ? [target] : ['-R', target] };
  if (platform === 'win32') return { cmd: 'explorer', args: safe ? [target] : [`/select,${target}`] };
  // xdg-open n'a pas de « révéler » : on ouvre le dossier qui contient le fichier (ou le dossier lui-même)
  return { cmd: 'xdg-open', args: [safe ? target : isDir ? target : path.dirname(target)] };
}

// ── L'environnement des processus claude ──

const ENV_NAMES = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ',
  // réseau d'entreprise et certificats : sans eux claude ne sort pas d'un réseau filtré
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']);
const ENV_WINDOWS = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'USERNAME', 'ProgramFiles', 'ProgramData', 'Path'];

/** Seulement ce dont claude a besoin : pas de clés d'API, de jetons ni de secrets de ton terminal. */
export function safeEnv(src: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const win = platform === 'win32' ? new Set(ENV_WINDOWS) : null;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (ENV_NAMES.has(k) || win?.has(k) || k.startsWith('LC_') || k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) out[k] = v;
  }
  return out;
}

// ── Windows : trouver et lancer claude ──

/** Les noms d'exécutable à chercher dans chaque dossier du PATH. */
export function claudeNames(platform: NodeJS.Platform = process.platform, pathext = process.env.PATHEXT): string[] {
  if (platform !== 'win32') return ['claude'];
  const exts = (pathext ?? '.EXE;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => e === '.exe' || e === '.cmd');
  return ['claude', ...new Set(['.exe', ...exts].map((e) => `claude${e}`))];
}

/**
 * Comment lancer claude. Sous Windows, un « .cmd » (le raccourci npm) ne peut pas être lancé sans passer par cmd.exe,
 * qui déforme les consignes du chef (guillemets, retours à la ligne) : on retrouve alors le vrai programme à côté du raccourci.
 */
export function launchSpec(bin: string, args: string[], platform: NodeJS.Platform = process.platform, exists = existsSync): Launch {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { cmd: bin, args };
  const pkg = path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code');
  const exe = path.join(pkg, 'bin', 'claude.exe');
  if (exists(exe)) return { cmd: exe, args };
  const cli = path.join(pkg, 'cli.js');
  if (exists(cli)) return { cmd: process.execPath, args: [cli, ...args] };
  throw new Error('Je ne sais pas lancer ce « claude.cmd » sans risque. Installe la version native de Claude Code (claude.exe), ou renseigne CLAUDE_BIN.');
}

// ── Lire un fichier sans tout charger ──

/** Retire de la fin d'un tampon coupé un caractère UTF-8 incomplet. */
export function trimUtf8(buf: Buffer): Buffer {
  let i = buf.length - 1;
  // on remonte d'au plus 3 octets de continuation (10xxxxxx) jusqu'à l'octet de tête
  for (let back = 0; i >= 0 && back < 4; back++, i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return buf.length - i < need ? buf.subarray(0, i) : buf;
  }
  return buf;
}
