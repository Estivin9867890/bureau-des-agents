// Le « disque » du bureau dans l'artifact : missions, enregistrements (pour rejouer), fichiers rendus et règlement.
// Tout vit en mémoire et se recopie dans localStorage quand il est disponible (dans une page sandboxée il peut
// être refusé : on reste alors en mémoire, sans erreur).
import type { FileInfo, Logged, MissionInfo, TeamEntry, VersionInfo } from '../../shared/protocol.ts';

export interface FileVersion { id: string; at: number; by: string; text: string }
export interface FileRec { info: FileInfo; versions: FileVersion[] }
interface Data {
  missions: MissionInfo[];
  logs: Record<string, Logged[]>;
  files: Record<string, Record<string, FileRec>>;
}

const KEY = 'bureau:artifact:v1';
const RULES_KEY = 'bureau:artifact:rules';
const MAX_MISSIONS = 12;
const MAX_VERSIONS = 12;

let data: Data = { missions: [], logs: {}, files: {} };
let rules: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): boolean { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

export function loadStore() {
  try {
    const raw = ls.get(KEY);
    if (raw) {
      const d = JSON.parse(raw) as Partial<Data>;
      data = { missions: d.missions ?? [], logs: d.logs ?? {}, files: d.files ?? {} };
      // une mission restée « au travail » (page fermée en route) est arrêtée
      for (const m of data.missions) if (m.status === 'working') m.status = 'stopped';
    }
  } catch { /* données illisibles : on repart propre */ }
}

function persist() {
  timer = null;
  // trop gros pour le stockage : on oublie les plus anciennes missions jusqu'à ce que ça passe
  for (;;) {
    if (ls.set(KEY, JSON.stringify(data))) return;
    const oldest = [...data.missions].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest || data.missions.length <= 1) return;
    forget(oldest.id);
  }
}

/** Sauvegarde groupée (au plus une fois par demi-seconde). */
export function save(now = false) {
  if (now) { if (timer) clearTimeout(timer); persist(); return; }
  if (!timer) timer = setTimeout(persist, 500);
}

function forget(id: string) {
  data.missions = data.missions.filter((m) => m.id !== id);
  delete data.logs[id];
  delete data.files[id];
}

export const missionsList = (): MissionInfo[] => [...data.missions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
export const getMission = (id: string) => data.missions.find((m) => m.id === id) ?? null;

export function addMission(m: MissionInfo) {
  data.missions.push(m);
  data.logs[m.id] = [];
  data.files[m.id] = {};
  const extra = [...data.missions].sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(0, data.missions.length - MAX_MISSIONS));
  for (const e of extra) forget(e.id);
  save();
}

export function addLog(id: string, l: Logged) { (data.logs[id] ??= []).push(l); save(); }
export const getLog = (id: string): Logged[] => data.logs[id] ?? [];

/** Range un fichier rendu (une nouvelle version si le texte a changé). Renvoie ses infos et s'il est nouveau. */
export function putFile(missionId: string, path: string, text: string, by: string): { info: FileInfo; isNew: boolean; changed: boolean } {
  const files = (data.files[missionId] ??= {});
  const prev = files[path];
  const at = Date.now();
  const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : '';
  const size = new Blob([text]).size;
  if (prev && prev.versions[prev.versions.length - 1]?.text === text) return { info: prev.info, isNew: false, changed: false };
  const info: FileInfo = { path, name: path.split('/').pop() ?? path, ext, size, at, by };
  const versions = [...(prev?.versions ?? []), { id: `${at}__${by.replace(/[^\w-]/g, '').slice(0, 64) || 'chef'}.${ext}`, at, by, text }].slice(-MAX_VERSIONS);
  files[path] = { info, versions };
  save();
  return { info, isNew: !prev, changed: true };
}

export const fileText = (missionId: string, path: string, version?: string): string | null => {
  const rec = data.files[missionId]?.[path];
  if (!rec) return null;
  if (version) return rec.versions.find((v) => v.id === version)?.text ?? null;
  return rec.versions[rec.versions.length - 1]?.text ?? null;
};

export const fileVersions = (missionId: string, path: string): VersionInfo[] =>
  [...(data.files[missionId]?.[path]?.versions ?? [])].reverse().map((v) => ({ id: v.id, at: v.at, size: new Blob([v.text]).size, by: v.by }));

/** Tous les agents passés au bureau (pour l'onglet Historique de l'équipe). */
export function teamHistory(): TeamEntry[] {
  const out: TeamEntry[] = [];
  for (const m of missionsList().slice(0, 40)) {
    const byId = new Map<string, TeamEntry>();
    for (const l of data.logs[m.id] ?? []) {
      const ev = l.ev;
      if (ev.k === 'hire') byId.set(ev.id, { missionId: m.id, missionTitle: m.title, at: l.at, id: ev.id, name: ev.name, role: ev.role, task: ev.task, status: 'working', tools: 0, tokens: 0, ms: 0, report: '' });
      else if (ev.k === 'report') { const e = byId.get(ev.who); if (e) e.report = ev.text.slice(0, 600); }
      else if (ev.k === 'leave') { const e = byId.get(ev.who); if (e) Object.assign(e, { status: ev.ok ? 'done' : 'failed', tools: ev.tools, tokens: ev.tokens, ms: ev.ms || l.at - e.at }); }
    }
    out.push(...[...byId.values()].reverse());
  }
  return out;
}

// ── Le règlement du bureau ──
export const RULES_TEMPLATE = `# Le règlement du bureau

Max, le chef de projet, lit ce texte avant chaque mission. Écris-y ce que l'équipe doit savoir
sur toi, avec tes mots, comme si tu briefais de nouveaux collègues.

## Qui je suis
(Par exemple : « Je m'appelle Alex, je suis coach sportif à Lyon. Je vends des programmes en ligne. »)

## Comment travailler pour moi
- Réponds-moi en français, simplement.
- Va droit au but : je veux des livrables prêts à servir.
`;

export function getRules(): string {
  if (rules === null) rules = ls.get(RULES_KEY) ?? RULES_TEMPLATE;
  return rules;
}
export function setRules(text: string) { rules = text.slice(0, 20000); ls.set(RULES_KEY, rules); }
/** Le règlement envoyé à Max : sans l'exemple par défaut s'il n'a pas été touché. */
export const rulesForChef = () => (getRules().trim() === RULES_TEMPLATE.trim() ? '' : getRules());

// ── L'aperçu d'un site ──
/**
 * Le code complet d'un site rendu, à mettre dans `<iframe srcDoc=… sandbox="allow-scripts allow-forms allow-popups allow-modals">`
 * (SANS allow-same-origin) : l'équivalent de /apercu/<mission>/<fichier> du bureau local. null si le fichier n'existe pas.
 */
export function previewDoc(missionId: string, file: string): string | null {
  const t = fileText(missionId, file);
  if (t === null) return null;
  // la page ne peut rien charger de l'extérieur : l'aperçu reste sans réseau (pas d'image externe, pas de pistage)
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">`;
  // le meta vient APRÈS le doctype (avant, il le ferait ignorer : mode « quirks »), dans un <head> créé si besoin
  if (/<head[^>]*>/i.test(t)) return t.replace(/<head[^>]*>/i, (h) => h + csp);
  const doctype = t.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '';
  const rest = t.slice(doctype.length);
  return /<html[^>]*>/i.test(rest) ? doctype + rest.replace(/<html[^>]*>/i, (h) => `${h}<head>${csp}</head>`) : `${doctype}<head>${csp}</head>${rest}`;
}
