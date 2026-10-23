// La connexion au pont (le serveur local qui pilote Claude Code). Sans pont (site public, téléphone),
// le bureau passe en démo : il rejoue une vraie mission enregistrée.
import type { ClientMsg, Logged, MissionInfo, ServerMsg } from '../../shared/protocol.ts';
import { useOffice } from '../state/store.ts';
import { IS_ARTIFACT } from './mode.ts';

let ws: WebSocket | null = null;
let everConnected = false;
let retry = 0;
let player: { stop: () => void } | null = null;
let lastReplay: { mission: MissionInfo; log: Logged[] } | null = null;
let build = '';

/** Le jeton de session glissé par le serveur dans la page (vide en développement : le serveur n'en exige pas). */
let token = document.querySelector<HTMLMetaElement>('meta[name="bureau-token"]')?.content ?? '';
/** Après un redémarrage du serveur, l'ancien jeton ne vaut plus : on relit la page pour avoir le nouveau. */
async function refreshToken() {
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const m = /<meta name="bureau-token" content="([0-9a-f]*)"/.exec(html);
    if (m) token = m[1];
  } catch { /* serveur éteint : on réessaiera */ }
}

export function sendToBridge(m: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  else useOffice.getState().toast('error', 'Le bureau n’est pas relié à Claude Code : lance « npm start » dans le dossier du bureau.');
}

/** Dans la page claude.ai (artifact) : pas de serveur. On salue la page parente ; si elle relaie Claude, le pont prend le relais. */
export const ARTIFACT_DEMO_TEXT = 'Ouvre ce bureau depuis le Carnet de veille sur claude.ai pour lancer de vraies missions.';

async function connectArtifact() {
  useOffice.setState({ connection: 'connecting' });
  const bridge = await import('./artifact-bridge.ts');
  const ok = window.parent !== window && (await bridge.handshake(3000));
  if (ok) {
    artifactRestore = bridge.restoreLive;
    bridge.startBridge({ playReplay });
  } else {
    useOffice.setState({ connection: 'offline' });
    await startDemo();
    useOffice.getState().toast('info', ARTIFACT_DEMO_TEXT);
  }
}
let artifactRestore: (() => void) | null = null;

export function connect() {
  if (IS_ARTIFACT) { void connectArtifact(); return; }
  void (retry > 0 ? refreshToken() : Promise.resolve()).then(openSocket);
}

function openSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws${token ? `?t=${encodeURIComponent(token)}` : ''}`);
  ws = socket;
  const failTimer = setTimeout(() => { if (!everConnected) socket.close(); }, 2500);
  socket.onopen = () => {
    clearTimeout(failTimer);
    everConnected = true;
    retry = 0;
    useOffice.setState({ connection: 'live', send: sendToBridge });
  };
  socket.onmessage = (e) => {
    let m: ServerMsg;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.t === 'replay') { playReplay(m.mission, m.log, 1); return; }
    if (m.t === 'hello' && m.build && m.build !== 'dev') {
      // le bureau a été mis à jour depuis l'ouverture de l'onglet : on recharge la page
      if (build && build !== m.build) { location.reload(); return; }
      build = m.build;
    }
    useOffice.getState().receive(m);
  };
  socket.onclose = () => {
    clearTimeout(failTimer);
    if (!everConnected) {
      useOffice.setState({ connection: 'offline' });
      void startDemo();
      return;
    }
    useOffice.setState({ connection: 'connecting' });
    setTimeout(connect, Math.min(8000, 600 * 2 ** retry++));
  };
}

/**
 * Rejoue une mission enregistrée, avec son rythme d'origine (les longues pauses sont raccourcies).
 * Pratique pour filmer : la même mission, autant de fois qu'on veut, sans relancer l'équipe.
 */
export function playReplay(mission: MissionInfo, log: Logged[], speed = 1, opts: { loop?: boolean; onEnd?: () => void } = {}) {
  player?.stop();
  lastReplay = { mission, log };
  const st = useOffice.getState();
  useOffice.setState({ replaying: true });
  st.resetMission({ ...mission, status: 'working' });
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = Date.now();
  let i = 0;
  let virt = 0;
  const step = () => {
    if (cancelled) return;
    if (i >= log.length) {
      if (opts.loop) { timer = setTimeout(() => { if (!cancelled) playReplay(mission, log, speed, opts); }, 9000); }
      opts.onEnd?.();
      return;
    }
    const l = log[i++];
    useOffice.getState().apply(l.ev, start + virt, true);
    if (i < log.length) {
      // le temps réel entre deux événements, accéléré, et jamais plus de 2,5 s d'attente
      const gap = Math.min(2500, Math.max(0, log[i].at - l.at) / speed);
      virt += gap;
      timer = setTimeout(step, gap);
    } else step();
  };
  timer = setTimeout(step, 600);
  player = { stop: () => { cancelled = true; if (timer) clearTimeout(timer); } };
  return player;
}

/** Reprend la rediffusion depuis le début, à une autre vitesse. */
export function replaySpeed(speed: number) {
  if (!lastReplay) return;
  playReplay(lastReplay.mission, lastReplay.log, speed, { loop: useOffice.getState().connection === 'demo' });
}

/** Arrête la rediffusion et revient au bureau en direct. */
export function stopReplay() {
  player?.stop();
  player = null;
  useOffice.setState({ replaying: false });
  if (artifactRestore) artifactRestore();
  else if (ws?.readyState === WebSocket.OPEN) {
    // on redemande l'état du bureau : le plus simple est de se reconnecter
    ws.close();
  } else useOffice.getState().resetMission(null);
}

/** Sans pont : la démo rejoue en boucle une vraie mission enregistrée. */
async function startDemo() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}demo/mission.json`);
    if (!res.ok) return;
    const data = (await res.json()) as { mission: MissionInfo; log: Logged[] };
    useOffice.setState({
      connection: 'demo',
      send: () => useOffice.getState().toast('info', IS_ARTIFACT ? ARTIFACT_DEMO_TEXT : 'C’est une démo : installe le Bureau des agents pour lancer ta propre équipe.'),
    });
    playReplay(data.mission, data.log, 1, { loop: true });
  } catch { /* pas de démo disponible */ }
}
