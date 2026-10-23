// Le mode « artifact » : le bureau tourne dans une page claude.ai, sans serveur local. Les vrais agents
// sont appelés par la page parente (relais postMessage). Drapeaux lus par l'interface :
//   - IS_ARTIFACT : vrai seulement dans le build `npm run build:artifact` ;
//   - useArtifact : l'état propre à ce mode (éditeur du règlement, relais disponible…).
import { create } from 'zustand';

export const IS_ARTIFACT: boolean = import.meta.env.MODE === 'artifact';

interface ArtifactState {
  /** la page parente relaie les appels Claude (sinon : démo) */
  available: boolean;
  /** l'éditeur du règlement du bureau est ouvert */
  rulesOpen: boolean;
}

export const useArtifact = create<ArtifactState>(() => ({ available: false, rulesOpen: false }));

/** Ouvre / ferme l'éditeur du règlement (remplace « ouvrir le fichier » du bureau local). */
export const openRules = () => useArtifact.setState({ rulesOpen: true });
export const closeRules = () => useArtifact.setState({ rulesOpen: false });
