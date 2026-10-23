// L'écran du bureau : la barre du haut, le bureau en pixel art (avec le panneau de l'équipe à droite),
// et Max en bas, à qui tu parles. Le cadre vertical (9:16) sert à filmer un reel.
import { useEffect, useRef, useState } from 'react';
import { jukebox } from './audio/music.ts';
import { sfx } from './audio/sfx.ts';
import { applySound } from './audio/sound.ts';
import { savePref, useOffice, type Tod } from './state/store.ts';
import { AskBar, Dialog } from './ui/Dialog.tsx';
import { FinalCard, History, SettingsPanel, Toasts, Viewer } from './ui/Modals.tsx';
import { Office } from './ui/Office.tsx';
import { Panel } from './ui/Panel.tsx';
import { Strips } from './ui/Strips.tsx';
import { party } from './ui/interact.ts';
import { ModalFrame, useTitleId, CloseButton } from './ui/Modal.tsx';
import { PanelContent } from './ui/Panel.tsx';
import { shortcutsOn } from './ui/prefs.ts';
import { RulesEditor } from './net/RulesEditor.tsx';
import { Rooms } from './ui/Rooms.tsx';
import { startTour, stopTour } from './ui/tour.ts';
import { TopBar } from './ui/TopBar.tsx';

const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];

const TOD_NEXT: Record<Tod, Tod> = { auto: 'day', day: 'evening', evening: 'night', night: 'auto' };

/** En mode tournage : un bouton pour en sortir, qui n'apparaît que quand la souris bouge (l'image reste propre). */
function ExitFilming() {
  const [shown, setShown] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraAuto = useOffice((s) => s.cameraAuto);
  useEffect(() => {
    const wake = () => {
      setShown(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(false), 2500);
    };
    wake();
    window.addEventListener('pointermove', wake);
    return () => { window.removeEventListener('pointermove', wake); if (timer.current) clearTimeout(timer.current); };
  }, []);
  return (
    <div className={`exit-filming ${shown ? 'shown' : ''}`}>
      <button onClick={() => { useOffice.setState({ cameraAuto: !cameraAuto }); savePref('cameraAuto', !cameraAuto); }}>{cameraAuto ? '🎥 Caméra auto : oui' : '🎥 Caméra auto : non'}</button>
      <button onClick={() => void startTour()}>🎤 Visite guidée</button>
      <button className="quit" onClick={() => useOffice.setState({ filming: false })}>✕ Quitter le tournage (F ou Échap)</button>
    </div>
  );
}

/** Sur téléphone (et en cadre vertical), le panneau de droite devient un tiroir « Aide ». */
function HelpDrawer({ onClose }: { onClose: () => void }) {
  const tid = useTitleId();
  useEffect(() => {
    const off = () => onClose();
    window.addEventListener('bureau:escape', off);
    return () => window.removeEventListener('bureau:escape', off);
  }, [onClose]);
  const draft = useOffice((s) => s.draft);
  useEffect(() => { if (draft) onClose(); }, [draft, onClose]);
  return (
    <ModalFrame onClose={onClose} titleId={tid} className="modal drawer">
      <div className="modal-head"><b id={tid}>Aide et mission</b><CloseButton onClick={onClose} /></div>
      <div className="modal-body drawer-body"><PanelContent /></div>
    </ModalFrame>
  );
}

export function App() {
  const vertical = useOffice((s) => s.vertical || s.portrait);
  const filming = useOffice((s) => s.filming);
  const [help, setHelp] = useState(false);

  // sur un écran en hauteur (téléphone), la mise en page verticale s'impose
  useEffect(() => {
    const onResize = () => useOffice.setState({ portrait: window.innerWidth / Math.max(1, window.innerHeight) < 0.8 });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let combo: string[] = [];
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useOffice.getState();
      const k = e.key.toLowerCase();
      // Échap ferme la fenêtre ouverte, même quand le focus est sur un champ ou une liste de la fenêtre
      if (k === 'escape') {
        if (s.tour) { stopTour(); return; }
        if (s.modal || s.viewer || s.historyOpen || s.settingsOpen || s.showFinal) {
          useOffice.setState({ modal: null, viewer: null, historyOpen: false, settingsOpen: false, showFinal: false });
          return;
        }
        if (s.filming) useOffice.setState({ filming: false });
        window.dispatchEvent(new Event('bureau:escape'));
        return;
      }
      // les raccourcis à une lettre : jamais dans un champ, et coupables dans les réglages (WCAG 2.1.4)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!shortcutsOn()) return;
      // le code secret (↑ ↑ ↓ ↓ ← → ← → B A) : le mode soirée
      combo = [...combo, k].slice(-KONAMI.length);
      if (combo.join() === KONAMI.join()) { combo = []; party(); return; }
      if (k === 't') { if (s.tour) stopTour(); else void startTour(); return; }
      if (k === 'c') { useOffice.setState({ cameraAuto: !s.cameraAuto }); savePref('cameraAuto', !s.cameraAuto); sfx('click'); return; }
      if (k === 'j') { jukebox.toggle(); return; }
      if (k === 'v') { useOffice.setState({ vertical: !s.vertical }); savePref('vertical', !s.vertical); sfx('click'); }
      else if (k === 'f') { useOffice.setState({ filming: !s.filming }); sfx('click'); }
      else if (k === 'n') { const n = TOD_NEXT[s.tod]; useOffice.setState({ tod: n }); savePref('tod', n); sfx('click'); }
      else if (k === 'm') { useOffice.setState({ sound: !s.sound }); savePref('sound', !s.sound); applySound(!s.sound); }
      else if (k === 'h') { useOffice.setState({ historyOpen: !s.historyOpen }); sfx('open'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app ${vertical ? 'vertical' : ''} ${filming ? 'filming' : ''}`}>
      <a className="skip" href="#mission-box" onClick={(e) => { e.preventDefault(); document.getElementById('mission-box')?.focus(); }}>Aller à la boîte de mission</a>
      <div className="frame">
        <TopBar onHelp={() => setHelp(true)} />
        <main className="main">
          <div className="stage">
            <Office />
            {vertical && <Strips />}
            <AskBar />
            <FinalCard />
          </div>
          {!vertical && !filming && <Panel />}
        </main>
        <Dialog />
      </div>
      {filming && <ExitFilming />}
      <Viewer />
      <Rooms />
      <History />
      <SettingsPanel />
      <RulesEditor />
      {help && <HelpDrawer onClose={() => setHelp(false)} />}
      <Toasts />
    </div>
  );
}
