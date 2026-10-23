// La barre du haut : le nom du bureau, la mission en cours et son chrono, les compteurs (agents,
// recherches, pages lues, rendus), l'énergie de ton abonnement, et les réglages d'affichage.
import { useEffect, useRef, useState } from 'react';
import { sfx } from '../audio/sfx.ts';
import { applySound } from '../audio/sound.ts';
import { replaySpeed, stopReplay } from '../net/link.ts';
import { savePref, useOffice, type Tod } from '../state/store.ts';
import { fmtClock } from './format.ts';
import { startTour } from './tour.ts';
import { useNarrow } from './prefs.ts';

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden="true">
      <span className="logo-visor"><i /><i /></span>
    </span>
  );
}

function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [on]);
}

const TOD_NEXT: Record<Tod, Tod> = { auto: 'day', day: 'evening', evening: 'night', night: 'auto' };
const TOD_ICON: Record<Tod, string> = { auto: '🕒', day: '☀️', evening: '🌇', night: '🌙' };
const TOD_LABEL: Record<Tod, string> = { auto: 'Heure de ton Mac', day: 'Jour', evening: 'Soir', night: 'Nuit' };

function Stat({ icon, label, n }: { icon: string; label: string; n: number }) {
  return <span><span aria-hidden="true">{icon} </span>{n}<span className="sr-only"> {label}</span></span>;
}

export function TopBar({ onHelp }: { onHelp: () => void }) {
  const mission = useOffice((s) => s.mission);
  const busySince = useOffice((s) => s.busySince);
  const workMs = useOffice((s) => s.workMs);
  const stats = useOffice((s) => s.stats);
  const files = useOffice((s) => s.files.length);
  const plan = useOffice((s) => s.plan);
  const quota = useOffice((s) => s.quota);
  const replaying = useOffice((s) => s.replaying);
  const connection = useOffice((s) => s.connection);
  const final = useOffice((s) => s.final);
  const vertical = useOffice((s) => s.vertical);
  const filming = useOffice((s) => s.filming);
  const sound = useOffice((s) => s.sound);
  const tod = useOffice((s) => s.tod);
  const musicOn = useOffice((s) => s.music.playing);
  const narrow = useNarrow();
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  useTick(busySince !== null);
  useEffect(() => {
    if (!menu) return;
    const off = () => { setMenu(false); menuBtn.current?.focus(); };
    const away = (e: PointerEvent) => { if (!menuBox.current?.contains(e.target as Node) && !menuBtn.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener('bureau:escape', off);
    window.addEventListener('pointerdown', away);
    return () => { window.removeEventListener('bureau:escape', off); window.removeEventListener('pointerdown', away); };
  }, [menu]);
  const elapsed = workMs + (busySince ? Date.now() - busySince : 0);
  const done = plan.filter((p) => p.status === 'completed').length;
  const current = plan.find((p) => p.status === 'in_progress') ?? plan.find((p) => p.status === 'pending');

  const status = !mission ? null : busySince ? 'live' : final?.ok ? 'done' : mission.status === 'error' ? 'error' : 'stopped';
  const toggle = (k: 'vertical' | 'filming' | 'sound') => {
    sfx('click');
    const v = !useOffice.getState()[k];
    useOffice.setState({ [k]: v });
    if (k !== 'filming') savePref(k, v);
    if (k === 'sound') applySound(v);
  };

  const items: { icon: string; label: string; title: string; run: () => void; on?: boolean }[] = [
    { icon: '🎤', label: 'Visite guidée', title: 'Visite guidée : Max présente son bureau (T)', run: () => void startTour() },
    { icon: '👥', label: 'Équipe', title: 'Toute l’équipe : les métiers, leurs outils, l’historique', run: () => { sfx('open'); useOffice.setState({ modal: { kind: 'team' } }); } },
    { icon: musicOn ? '🎶' : '🎵', label: 'Jukebox', title: 'Le jukebox (J)', run: () => { sfx('open'); useOffice.setState({ modal: { kind: 'jukebox' } }); }, on: musicOn },
    { icon: '🗂️', label: 'Missions précédentes', title: 'Missions précédentes (H)', run: () => { sfx('open'); useOffice.setState({ historyOpen: true }); } },
    { icon: TOD_ICON[tod], label: `Heure : ${TOD_LABEL[tod]}`, title: `L’heure du bureau : ${TOD_LABEL[tod]} (N)`, run: () => { sfx('click'); const n = TOD_NEXT[tod]; useOffice.setState({ tod: n }); savePref('tod', n); } },
    { icon: sound ? '🔊' : '🔇', label: sound ? 'Couper le son' : 'Remettre le son', title: sound ? 'Couper le son (M)' : 'Remettre le son (M)', run: () => toggle('sound') },
    { icon: '📱', label: 'Cadre vertical (reel)', title: 'Cadre vertical 9:16, pour filmer un reel (V)', run: () => toggle('vertical'), on: vertical },
    { icon: '🎬', label: 'Mode tournage', title: 'Mode tournage : juste le bureau et Max (F)', run: () => toggle('filming'), on: filming },
    { icon: '⚙️', label: 'Réglages', title: 'Réglages', run: () => { sfx('open'); useOffice.setState({ settingsOpen: true }); } },
  ];

  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <div>
          <h1>Le Bureau des agents</h1>
          <span>{connection === 'demo' ? 'Démo · VibesMoney' : 'par VibesMoney'}</span>
        </div>
      </div>

      <div className="mission-head">
        {mission ? (
          <>
            <span className={`dot ${status}`} aria-hidden="true" />
            <span className="mission-title" title={mission.prompt}>{mission.title}</span>
            <span className="sr-only" role="status">{`Mission ${status === 'live' ? 'en cours' : status === 'done' ? 'terminée' : status === 'error' ? 'en erreur' : 'arrêtée'} : ${mission.title}`}</span>
            <span className="timer" aria-hidden="true">{fmtClock(elapsed)}</span>
          </>
        ) : <span className="muted">Aucune mission en cours</span>}
        {mission && plan.length > 0 && (
          <span className="plan-step" title={current?.text ?? ''}><span aria-hidden="true">📋 </span><span className="sr-only">Plan : </span>{done}/{plan.length}{current && busySince ? ` · ${current.text}` : ''}</span>
        )}
      </div>

      {mission && (
        <div className="stats">
          <Stat icon="🤖" label="agents appelés" n={stats.agents} />
          <Stat icon="🔎" label="recherches sur internet" n={stats.searches} />
          <Stat icon="🌐" label="pages web lues" n={stats.pages} />
          <Stat icon="📄" label="fichiers rendus" n={files} />
        </div>
      )}

      {replaying && (
        <div className="replay-bar">
          <span>Rediffusion</span>
          {[1, 2, 4].map((x) => <button key={x} onClick={() => replaySpeed(x)}>×{x}</button>)}
          {connection !== 'demo' && <button onClick={() => { sfx('click'); stopReplay(); }}>Quitter</button>}
        </div>
      )}

      <nav className="bar-tools" aria-label="Outils du bureau">
        {quota && (
          <span className="energy" title={`Ton abonnement sur 5 heures : ${Math.round(quota.fiveHour * 100)} % utilisés`} role="img" aria-label={`Énergie de ton abonnement : ${Math.round(100 - quota.fiveHour * 100)} % restants sur 5 heures`}>
            <span className="energy-label">Énergie</span>
            <span className="energy-bar"><i style={{ width: `${Math.max(3, 100 - quota.fiveHour * 100)}%` }} /></span>
          </span>
        )}
        {(vertical || narrow) && !filming && <button className="help-btn" onClick={() => { sfx('open'); onHelp(); }}>Aide</button>}
        {narrow ? (
          <>
            <button ref={menuBtn} data-return-focus className="icon-btn" aria-label="Plus d’outils" aria-haspopup="true" aria-expanded={menu} aria-controls="more-menu" onClick={() => { sfx('click'); setMenu((m) => !m); }}><span aria-hidden="true">⋯</span></button>
            {menu && (
              <div id="more-menu" ref={menuBox} className="more-menu">
                {items.map((it) => (
                  <button key={it.label} className={it.on ? 'on' : ''} aria-pressed={it.on === undefined ? undefined : it.on} onClick={() => { setMenu(false); it.run(); }}>
                    <span aria-hidden="true">{it.icon}</span>{it.label}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : items.map((it) => (
          <button key={it.label} className={`icon-btn ${it.on ? 'on' : ''}`} title={it.title} aria-label={it.label} aria-pressed={it.on === undefined ? undefined : it.on} data-return-focus={it.label === 'Réglages' ? '' : undefined} onClick={it.run}>
            <span aria-hidden="true">{it.icon}</span>
          </button>
        ))}
      </nav>
    </header>
  );
}
