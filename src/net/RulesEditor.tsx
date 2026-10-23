// L'éditeur du règlement du bureau (mode artifact) : à la place du fichier « Règlement du bureau.md » du bureau local.
// À monter une fois dans l'interface : <RulesEditor />. Il s'ouvre quand `useArtifact.rulesOpen` est vrai
// (le bouton « Le règlement du bureau » envoie { t: 'open_root', rules: true }, que le pont traduit en `openRules()`).
import { useEffect, useState } from 'react';
import { getRules, RULES_TEMPLATE, setRules } from './artifact-store.ts';
import { CloseButton, ModalFrame, useTitleId } from '../ui/Modal.tsx';
import { closeRules, IS_ARTIFACT, useArtifact } from './mode.ts';

export function RulesEditor() {
  const open = useArtifact((s) => s.rulesOpen);
  const [text, setText] = useState('');
  const tid = useTitleId();
  useEffect(() => { if (open) setText(getRules()); }, [open]);
  // Échap : App.tsx diffuse « bureau:escape » quand aucune autre fenêtre n'est ouverte
  useEffect(() => {
    if (!open) return;
    window.addEventListener('bureau:escape', closeRules);
    return () => window.removeEventListener('bureau:escape', closeRules);
  }, [open]);
  if (!IS_ARTIFACT || !open) return null;
  const save = () => { setRules(text); closeRules(); };
  return (
    <ModalFrame onClose={closeRules} titleId={tid} className="modal">
        <div className="modal-head"><b id={tid}>Le règlement du bureau</b><CloseButton onClick={closeRules} /></div>
        <div className="modal-body">
          <p className="small muted">Écris ce que l’équipe doit savoir sur toi : Max le lit avant chaque mission. Il reste sur cet appareil.</p>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} aria-label="Le règlement"
            style={{ width: '100%', minHeight: 240, resize: 'vertical', font: 'inherit', padding: 10, borderRadius: 8, background: 'rgba(255,255,255,.06)', color: 'inherit', border: '1px solid rgba(255,255,255,.18)' }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={save}>Enregistrer</button>
            <button className="btn ghost" onClick={() => setText(RULES_TEMPLATE)}>Remettre le modèle</button>
          </div>
        </div>
    </ModalFrame>
  );
}
