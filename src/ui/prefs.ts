// Deux préférences d'accessibilité : les raccourcis à une lettre (WCAG 2.1.4) et la réduction des animations.
import { useSyncExternalStore } from 'react';

const KEY = 'bureau:shortcuts';
let shortcuts = true;
try { shortcuts = localStorage.getItem(KEY) !== 'off'; } catch { /* navigation privée */ }
const subs = new Set<() => void>();

export const shortcutsOn = () => shortcuts;
export function setShortcuts(on: boolean) {
  shortcuts = on;
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* navigation privée */ }
  subs.forEach((f) => f());
}
export function useShortcuts() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => shortcuts);
}

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
/** Vrai si la personne a demandé moins d'animations dans son système. */
export const reducedMotion = () => !!mq?.matches;
export function useReducedMotion() {
  return useSyncExternalStore(
    (cb) => { mq?.addEventListener('change', cb); return () => mq?.removeEventListener('change', cb); },
    () => !!mq?.matches,
  );
}

const nar = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
/** Écran étroit (téléphone) : même seuil que le CSS. */
export function useNarrow() {
  return useSyncExternalStore(
    (cb) => { nar?.addEventListener('change', cb); return () => nar?.removeEventListener('change', cb); },
    () => !!nar?.matches,
  );
}
