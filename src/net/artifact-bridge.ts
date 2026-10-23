// Le pont de l'artifact : il fait le travail du serveur local (server/bureau.ts + claude.ts) sans serveur.
// Les vrais agents sont des appels à Claude, relayés par la page parente (claude.ai) en postMessage ; le pont
// en tire les mêmes messages que le serveur (ServerMsg) pour que le bureau ne voie aucune différence.
//
// Protocole du relais (iframe → parent, puis retour) :
//   bureau-hello → bureau-ready {available}
//   bureau-sample {id, input, opts:{modelTier?, json?}} → bureau-sample-text {id, text} (texte complet, en continu)
//                                                       → bureau-sample-done {id, text, value?} | bureau-sample-error {id, code, message}
//   bureau-sample-abort {id}
import { countStats, emptyStats, NAMES, ROLES, roleOfType } from '../../shared/activity.ts';
import type { ClientMsg, Logged, MissionInfo, OfficeEvent, PlanItem, Role, ServerMsg, Settings } from '../../shared/protocol.ts';
import { useOffice } from '../state/store.ts';
import {
  addLog, addMission, fileText, fileVersions, getLog, getMission, loadStore, missionsList, putFile, rulesForChef, save, teamHistory,
} from './artifact-store.ts';
import { agentPrompt, assemblePrompt, followPrompt, MAX_AGENTS, planPrompt, TEAM_TYPES } from './artifact-prompts.ts';
import { openRules, useArtifact } from './mode.ts';
import { getRules, previewDoc } from './artifact-store.ts';

// ── Le client du relais ──
type Msg = { role: 'user' | 'assistant'; content: string };
interface SampleOpts { modelTier?: string; json?: boolean }

export class SampleError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

interface Waiting { onText?: (t: string) => void; resolve: (r: { text: string; value?: unknown }) => void; reject: (e: SampleError) => void }
const waiting = new Map<string, Waiting>();
let seq = 0;
let listening = false;

function onParentMessage(e: MessageEvent) {
  if (e.source !== window.parent) return;
  const d = e.data as { type?: string; id?: string; text?: string; value?: unknown; code?: string; message?: string } | null;
  if (!d || typeof d.type !== 'string' || typeof d.id !== 'string') return;
  const w = waiting.get(d.id);
  if (!w) return;
  if (d.type === 'bureau-sample-text') w.onText?.(String(d.text ?? ''));
  else if (d.type === 'bureau-sample-done') { waiting.delete(d.id); w.resolve({ text: String(d.text ?? ''), value: d.value }); }
  else if (d.type === 'bureau-sample-error') { waiting.delete(d.id); w.reject(new SampleError(String(d.code ?? 'unavailable'), String(d.message ?? ''))); }
}

/** Un appel à Claude par le relais. `onText` reçoit le texte complet à chaque morceau ; `signal` l'abandonne. */
export function sample(input: string | Msg[], opts: SampleOpts, onText?: (t: string) => void, signal?: AbortSignal): Promise<{ text: string; value?: unknown }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SampleError('cancelled', 'Annulé.')); return; }
    const id = `s${++seq}-${Math.random().toString(36).slice(2, 7)}`;
    const abort = () => {
      if (!waiting.delete(id)) return;
      window.parent.postMessage({ type: 'bureau-sample-abort', id }, '*');
      reject(new SampleError('cancelled', 'Annulé.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    waiting.set(id, {
      onText,
      resolve: (r) => { signal?.removeEventListener('abort', abort); resolve(r); },
      reject: (e) => { signal?.removeEventListener('abort', abort); reject(e); },
    });
    window.parent.postMessage({ type: 'bureau-sample', id, input, opts }, '*');
  });
}

/** Salue la page parente : vrai si elle relaie les appels à Claude (réponse en moins de `ms` millisecondes). */
export function handshake(ms = 3000): Promise<boolean> {
  if (!listening) { window.addEventListener('message', onParentMessage); listening = true; }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(t); window.removeEventListener('message', onReady); resolve(v); };
    const onReady = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const d = e.data as { type?: string; available?: boolean } | null;
      if (d?.type === 'bureau-ready') finish(d.available === true);
    };
    const t = setTimeout(() => finish(false), ms);
    window.addEventListener('message', onReady);
    window.parent.postMessage({ type: 'bureau-hello' }, '*');
  });
}

const FATAL = new Set(['not_granted', 'rate_limited', 'sampling_disabled', 'unavailable']);
function errorText(e: unknown): string {
  const err = e instanceof SampleError ? e : new SampleError('unavailable', e instanceof Error ? e.message : String(e));
  switch (err.code) {
    case 'not_granted': return 'Autorise Claude pour cette page (menu Permissions de l’artifact), puis relance la mission.';
    case 'rate_limited': return 'Claude a besoin d’une pause : la limite d’utilisation est atteinte. Réessaie un peu plus tard.';
    case 'sampling_disabled': return 'Les appels à Claude sont désactivés pour cette page.';
    case 'unavailable': return 'Claude n’est pas joignable pour l’instant. Réessaie dans un moment.';
    case 'refused': return 'Claude a refusé cette demande.';
    default: return `Claude a rencontré un problème${err.message ? ` (${err.message})` : ''}.`;
  }
}

// ── Les petits outils ──
const emit = (m: ServerMsg) => useOffice.getState().receive(m);
const toast = (kind: 'info' | 'error', text: string) => emit({ t: 'toast', kind, text });
const cut = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
const pad = (n: number) => String(n).padStart(2, '0');

function titleOf(prompt: string) {
  const first = prompt.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  let t = first.replace(/[.!?:;,]+$/, '');
  if (t.length > 46) t = t.slice(0, 46).replace(/\s+\S*$/, '') + '…';
  return t ? t[0].toUpperCase() + t.slice(1) : 'Mission';
}

const HTML_RE = /```html[^\n]*\n([\s\S]*?)```/i;
const HTML_OPEN_RE = /```html[^\n]*\n([\s\S]*)$/i;
/** Sépare un texte en Markdown et en site HTML éventuel (bloc ```html). */
function splitHtml(text: string): { md: string; html: string | null } {
  const m = text.match(HTML_RE) ?? text.match(HTML_OPEN_RE);
  if (!m) return { md: text, html: null };
  const html = m[1].trim();
  const md = text.replace(m[0], '*(Le site est dans le fichier index.html.)*').trim();
  return { md, html: /<\w+/.test(html) ? html : null };
}

interface PlanAgent { type: string; role: Role; nom: string; tache: string; brief: string }
function parsePlan(value: unknown, text: string): { message: string; agents: PlanAgent[] } | null {
  let v = value as { message?: unknown; agents?: unknown } | null | undefined;
  if (!v || typeof v !== 'object') {
    const m = text.match(/\{[\s\S]*\}/);
    try { v = m ? JSON.parse(m[0]) : null; } catch { v = null; }
  }
  if (!v || typeof v !== 'object') return null;
  const message = typeof v.message === 'string' ? v.message.trim() : '';
  const raw = Array.isArray(v.agents) ? v.agents : [];
  const agents: PlanAgent[] = [];
  for (const a of raw.slice(0, MAX_AGENTS) as Record<string, unknown>[]) {
    const brief = typeof a?.brief === 'string' ? a.brief.trim() : '';
    if (!brief) continue;
    const type = (TEAM_TYPES as readonly string[]).includes(String(a.role)) ? String(a.role) : 'redacteur';
    agents.push({
      type, role: roleOfType(type), nom: typeof a.nom === 'string' ? a.nom.trim() : '',
      tache: typeof a.tache === 'string' && a.tache.trim() ? cut(a.tache, 34) : cut(brief, 34), brief,
    });
  }
  return { message, agents };
}

// ── La mission en cours ──
interface Run {
  mission: MissionInfo;
  ctrl: AbortController;
  history: Msg[];
  names: Set<string>;
  present: Set<string>;
  notes: string[];
  reports: { name: string; role: string; task: string; text: string }[];
  site: boolean;
  busySince: number;
  /** la fin est lancée */
  finished: boolean;
  /** la fin est enregistrée : plus aucun événement ne passe */
  sealed: boolean;
  stopAsked: boolean;
  lastChef: string;
  uid: number;
}

let run: Run | null = null;
let settings: Settings = { chefModel: 'sonnet', teamModel: 'sonnet', permission: 'auto' };
let deps: { playReplay: (m: MissionInfo, log: Logged[], speed: number) => unknown } | null = null;

function record(r: Run, ev: OfficeEvent) {
  if (r.sealed) return;
  const at = Date.now();
  emit({ t: 'ev', missionId: r.mission.id, at, ev });
  if (ev.k === 'typing') return;
  countStats(r.mission.stats, ev);
  addLog(r.mission.id, { at, ev });
}

const nextId = (r: Run, p: string) => `${p}${++r.uid}`;

function putMissionFile(r: Run, path: string, text: string, by: string) {
  if (r.sealed) return;
  const { info, isNew, changed } = putFile(r.mission.id, path, text, by);
  if (!changed) return;
  const files = r.mission.files;
  const i = files.findIndex((f) => f.path === path);
  if (i >= 0) files[i] = info; else files.push(info);
  record(r, { k: 'file', file: info, isNew });
  emit({ t: 'mission', mission: r.mission });
}

function finish(r: Run, ok: boolean, text: string) {
  if (r.finished) return;
  r.finished = true;
  const m = r.mission;
  for (const id of r.present) record(r, { k: 'leave', who: id, ok: false, tokens: 0, tools: 0, ms: 0 });
  r.present.clear();
  const now = Date.now();
  const stopped = r.stopAsked;
  m.status = ok ? 'done' : stopped ? 'stopped' : 'error';
  m.endedAt = now;
  m.workMs += now - r.busySince;
  if (text) m.final = text.slice(0, 20000);
  record(r, { k: 'end', ok, text: m.final ?? '', ms: now - r.busySince, stopped });
  r.sealed = true;
  emit({ t: 'mission', mission: m });
  save(true);
}

/** Une erreur de Claude : si elle bloque tout (autorisation, limite…), on arrête proprement, sans boucle. */
function fail(r: Run, e: unknown) {
  if (r.finished) return;
  if (e instanceof SampleError && e.code === 'cancelled') { finish(r, false, r.lastChef); return; }
  const text = errorText(e);
  record(r, { k: 'error', message: text });
  r.ctrl.abort();
  finish(r, false, text);
}

async function chefCall(r: Run, content: string, opts: SampleOpts = {}) {
  r.history.push({ role: 'user', content });
  try {
    const res = await sample(r.history, opts, undefined, r.ctrl.signal);
    r.history.push({ role: 'assistant', content: res.text });
    return res;
  } catch (e) {
    r.history.pop();
    throw e;
  }
}

// ── Un agent ──
/** Ce que fait l'agent, d'après ce qu'il a écrit jusque-là (c'est ce qui anime sa bulle). */
function activity(text: string, type: string): { stage: number; label: string } {
  if (!/```html/i.test(text)) return { stage: 1, label: 'J’écris le rapport' };
  if (/```html[^\n]*\n[\s\S]*?```/i.test(text)) return { stage: 3, label: 'Je relis ma page' };
  return { stage: 2, label: type === 'developpeur' ? 'J’écris le code' : 'Je dessine la page' };
}

async function runAgent(r: Run, id: string, a: PlanAgent, name: string) {
  const t0 = Date.now();
  let actId = nextId(r, 'x');
  let stage = 0;
  let lastTyping = 0;
  record(r, { k: 'act', who: id, id: actId, kind: 'other', tool: 'sample', label: 'Je réfléchis', detail: '' });
  record(r, { k: 'think', who: id });
  const prompt = agentPrompt(a.type, a.brief, r.mission.prompt, rulesForChef());
  try {
    const res = await sample(prompt, {}, (text) => {
      const act = activity(text, a.type);
      if (act.stage > stage) {
        stage = act.stage;
        record(r, { k: 'act_done', who: id, id: actId, ok: true });
        actId = nextId(r, 'x');
        record(r, { k: 'act', who: id, id: actId, kind: 'write', tool: 'sample', label: act.label, detail: '' });
      }
      const now = Date.now();
      if (now - lastTyping > 900 && act.stage === 1) {
        lastTyping = now;
        const line = text.split('\n').map((l) => l.replace(/^[#>*\-\s|]+/, '').trim()).filter(Boolean).pop();
        if (line) record(r, { k: 'typing', who: id, text: cut(line, 70) });
      }
    }, r.ctrl.signal);
    const { md, html } = splitHtml(res.text);
    record(r, { k: 'act_done', who: id, id: actId, ok: true });
    record(r, { k: 'report', who: id, text: md });
    r.reports.push({ name, role: ROLES[a.role].label, task: a.tache, text: md });
    putMissionFile(r, `rapport-${slug(name)}.md`, md, id);
    if (html) { putMissionFile(r, 'index.html', html, id); r.site = true; }
    // laisse le temps au robot de poser son rapport avant de repartir
    await sleep(1200, r.ctrl.signal);
    record(r, { k: 'leave', who: id, ok: true, tokens: Math.round((prompt.length + res.text.length) / 4), tools: 0, ms: Date.now() - t0 });
    r.present.delete(id);
  } catch (e) {
    record(r, { k: 'act_done', who: id, id: actId, ok: false });
    if (e instanceof SampleError && !FATAL.has(e.code) && e.code !== 'cancelled') {
      record(r, { k: 'report', who: id, text: `Je n’ai pas pu terminer : ${errorText(e)}` });
      record(r, { k: 'leave', who: id, ok: false, tokens: 0, tools: 0, ms: Date.now() - t0 });
      r.present.delete(id);
    } else fail(r, e);
  }
}

// ── La mission ──
async function work(r: Run, request: string) {
  try {
    record(r, { k: 'think', who: 'chef' });
    const res = await chefCall(r, planPrompt(request, rulesForChef()), { json: true });
    const plan = parsePlan(res.value, res.text);
    if (!plan) { finish(r, true, 'Je n’ai pas réussi à faire le plan. Reformule ta demande, et on réessaie.'); return; }
    if (plan.message) { r.lastChef = plan.message; record(r, { k: 'say', who: 'chef', text: plan.message }); }
    if (!plan.agents.length) { finish(r, true, plan.message || 'C’est noté !'); return; }

    const items: PlanItem[] = [...plan.agents.map((a): PlanItem => ({ text: a.tache, status: 'in_progress' })), { text: 'Assembler le rendu', status: 'pending' }];
    const setItem = (i: number, status: PlanItem['status']) => { items[i] = { ...items[i], status }; record(r, { k: 'plan', items: items.map((x) => ({ ...x })) }); };
    record(r, { k: 'plan', items: items.map((x) => ({ ...x })) });
    // Ils arrivent l'un après l'autre (5 au plus), puis travaillent tous en même temps
    const jobs: Promise<void>[] = [];
    for (const [i, a] of plan.agents.entries()) {
      const pool = NAMES[a.role].filter((n) => !r.names.has(n));
      const name = a.nom && a.nom.length <= 14 && !r.names.has(a.nom) ? a.nom : pool[0] ?? `${NAMES[a.role][0]} ${r.names.size + 1}`;
      r.names.add(name);
      const id = nextId(r, 'a');
      record(r, { k: 'hire', id, role: a.role, type: a.type, name, task: a.tache, prompt: a.brief });
      r.present.add(id);
      jobs.push(runAgent(r, id, a, name).then(() => setItem(i, 'completed')));
      await sleep(500, r.ctrl.signal);
    }
    await Promise.all(jobs);
    if (r.finished) return;
    if (r.ctrl.signal.aborted) { finish(r, false, r.lastChef); return; }
    if (!r.reports.length) { finish(r, false, 'Personne n’a pu rendre son travail.'); return; }

    // Max assemble
    record(r, { k: 'think', who: 'chef' });
    const actId = nextId(r, 'x');
    record(r, { k: 'act', who: 'chef', id: actId, kind: 'write', tool: 'sample', label: 'J’assemble le rapport', detail: '' });
    setItem(items.length - 1, 'in_progress');
    const out = await chefCall(r, assemblePrompt(r.reports, r.notes, r.site));
    r.notes = [];
    record(r, { k: 'act_done', who: 'chef', id: actId, ok: true });
    const [body, tail] = out.text.split(/^\s*-{3}\s*MESSAGE\s*-{3}\s*$/m);
    const { md, html } = splitHtml(body.trim());
    putMissionFile(r, 'rapport.md', md, 'chef');
    if (html) { putMissionFile(r, 'index.html', html, 'chef'); r.site = true; }
    setItem(items.length - 1, 'completed');
    const msg = (tail ?? '').trim() || `L’équipe a rendu son travail : ${r.site ? 'rapport.md et index.html' : 'rapport.md'} sont dans l’imprimante.`;
    r.lastChef = msg;
    record(r, { k: 'say', who: 'chef', text: msg });
    finish(r, true, msg);
  } catch (e) { fail(r, e); }
}

/** Une retouche : on reparle à Max, avec tout l'historique de la mission. */
async function follow(r: Run, text: string) {
  try {
    record(r, { k: 'think', who: 'chef' });
    const actId = nextId(r, 'x');
    record(r, { k: 'act', who: 'chef', id: actId, kind: 'write', tool: 'sample', label: 'Je m’en occupe', detail: '' });
    const res = await chefCall(r, followPrompt(text, r.site));
    record(r, { k: 'act_done', who: 'chef', id: actId, ok: true });
    const [head, livrable] = res.text.split(/^\s*-{3}\s*LIVRABLE\s*-{3}\s*$/m);
    const { md: message, html } = splitHtml(head.trim());
    if (livrable?.trim()) {
      const part = splitHtml(livrable.trim());
      putMissionFile(r, 'rapport.md', part.md, 'chef');
      if (part.html && !html) { putMissionFile(r, 'index.html', part.html, 'chef'); r.site = true; }
    }
    if (html) { putMissionFile(r, 'index.html', html, 'chef'); r.site = true; }
    const msg = message.replace(/\*\(Le site est dans le fichier index\.html\.\)\*/g, '').trim() || 'C’est fait !';
    r.lastChef = msg;
    record(r, { k: 'say', who: 'chef', text: msg });
    finish(r, true, msg);
  } catch (e) { fail(r, e); }
}

function startMission(prompt: string) {
  const text = prompt.trim();
  if (!text) { toast('error', 'Dis à Max ce que tu veux.'); return; }
  if (run?.mission.status === 'working') { toast('error', 'L’équipe est déjà sur une mission. Attends qu’elle la rende, ou arrête-la.'); return; }
  if (run) closeMission();
  const now = new Date();
  const title = titleOf(text);
  const mission: MissionInfo = {
    id: 'm' + Date.now().toString(36), title, prompt: text,
    folder: `Missions/${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}h${pad(now.getMinutes())} · ${title.replace(/…$/, '')}`,
    createdAt: Date.now(), workMs: 0, status: 'working', stats: emptyStats(), files: [],
  };
  addMission(mission);
  const r: Run = {
    mission, ctrl: new AbortController(), history: [], names: new Set(), present: new Set(), notes: [], reports: [], site: false,
    busySince: Date.now(), finished: false, sealed: false, stopAsked: false, lastChef: '', uid: 0,
  };
  run = r;
  emit({ t: 'mission', mission });
  record(r, { k: 'start', text });
  record(r, { k: 'init', model: 'Claude (via la page)', auth: 'none' });
  void work(r, text);
}

function sayToMax(text: string) {
  const clean = text.trim();
  if (!clean) return;
  const r = run;
  if (!r) { toast('error', 'Lance d’abord une mission.'); return; }
  if (r.mission.status === 'working') {
    // Max le garde en tête et en tient compte quand il assemble le rendu
    r.notes.push(clean);
    record(r, { k: 'start', text: clean });
    return;
  }
  r.finished = false;
  r.sealed = false;
  r.stopAsked = false;
  r.ctrl = new AbortController();
  r.busySince = Date.now();
  r.mission.status = 'working';
  r.mission.endedAt = undefined;
  emit({ t: 'mission', mission: r.mission });
  record(r, { k: 'start', text: clean });
  void follow(r, clean);
}

function stopMission() {
  const r = run;
  if (!r || r.mission.status !== 'working') return;
  r.stopAsked = true;
  r.ctrl.abort();
  finish(r, false, r.lastChef);
}

function closeMission() {
  const r = run;
  if (!r) return;
  if (r.mission.status === 'working') { r.stopAsked = true; r.ctrl.abort(); finish(r, false, r.lastChef); }
  run = null;
  emit({ t: 'closed', missionId: r.mission.id });
}

function helloMsg(): ServerMsg {
  return {
    t: 'hello', claude: { found: true, version: 'artifact' }, dir: 'Bureau dans le Carnet de veille', settings, quota: null,
    missions: missionsList(), current: run ? { mission: run.mission, log: getLog(run.mission.id) } : null,
  };
}

/** Ce que le bureau envoie au « serveur » : le pont répond comme le ferait le vrai serveur. */
export function sendClient(m: ClientMsg) {
  try {
    switch (m.t) {
      case 'start': startMission(m.prompt); break;
      case 'say': sayToMax(m.text); break;
      case 'stop': stopMission(); break;
      case 'new': closeMission(); break;
      case 'answer': break; // pas d'outils dangereux : aucune permission à demander
      case 'settings':
        settings = { ...settings, ...m.settings, permission: 'auto' };
        emit({ t: 'settings', settings });
        break;
      case 'open_root':
        if (m.rules) openRules();
        else toast('info', 'Il n’y a pas de dossier ici : les rendus sont dans l’imprimante du bureau.');
        break;
      case 'open': {
        const t = m.file ? fileText(m.missionId, m.file) : null;
        if (t === null || !m.file) { toast('info', 'Les rendus sont dans l’imprimante du bureau (clique-la pour les lire).'); break; }
        download(m.file, t);
        break;
      }
      case 'read': {
        const text = fileText(m.missionId, m.file, m.version);
        if (text === null) { toast('error', 'Ce fichier n’existe plus.'); break; }
        const max = 400_000;
        emit({ t: 'file_text', missionId: m.missionId, file: m.file, text: text.slice(0, max), truncated: text.length > max, version: m.version });
        break;
      }
      case 'versions': emit({ t: 'versions', missionId: m.missionId, file: m.file, list: fileVersions(m.missionId, m.file) }); break;
      case 'team_history': emit({ t: 'team_history', entries: teamHistory() }); break;
      case 'replay': {
        const mission = getMission(m.missionId);
        const log = getLog(m.missionId);
        if (!mission || !log.length) { toast('error', 'Cette mission n’a pas été enregistrée.'); break; }
        deps?.playReplay(mission, log, 1);
        break;
      }
    }
  } catch (e) { toast('error', e instanceof Error ? e.message : 'Quelque chose s’est mal passé.'); }
}

function download(name: string, text: string) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: name.endsWith('.html') ? 'text/html' : 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url; a.download = name.split('/').pop() ?? name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch { toast('info', 'Le téléchargement n’est pas permis dans cette page : lis le fichier dans l’imprimante.'); }
}

/** Le pont démarre : le bureau parle désormais à ce pont plutôt qu'à un serveur. */
export function startBridge(d: NonNullable<typeof deps>) {
  deps = d;
  loadStore();
  useArtifact.setState({ available: true });
  useOffice.setState({ connection: 'live', send: sendClient });
  // pour les tests : window.__bureau.artifact
  const w = window as unknown as { __bureau?: Record<string, unknown> };
  if (w.__bureau) w.__bureau.artifact = { previewDoc, getRules, sendClient };
  emit(helloMsg());
}

/** Fin d'une rediffusion : on revient au bureau en direct (la mission en cours, ou le bureau vide). */
export function restoreLive() { emit(helloMsg()); }
