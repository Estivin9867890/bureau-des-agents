// Le cadre commun de toutes les fenêtres : rôle « dialog », focus qui entre dans la fenêtre à l'ouverture,
// Tab qui n'en sort pas, et focus rendu au bouton qui l'a ouverte à la fermeture. Échap est géré dans App.tsx.
import { useEffect, useId, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Garde le focus dans `ref` tant que la fenêtre est ouverte, puis le rend à l'élément qui l'avait avant. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    root.focus({ preventScroll: true });
    const items = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = items();
      if (!list.length) { e.preventDefault(); root.focus(); return; }
      const first = list[0], last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root || !root.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus(); }
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
      // le déclencheur a pu disparaître (menu « ⋯ » refermé) : on se rabat sur le bouton marqué
      const back = opener && opener.isConnected && opener !== document.body ? opener : document.querySelector<HTMLElement>('[data-return-focus]');
      setTimeout(() => { if (!document.querySelector('[role="dialog"][aria-modal="true"]')) back?.focus({ preventScroll: true }); }, 0);
    };
  }, [ref]);
}

/** Une fenêtre modale : fond sombre cliquable pour fermer + boîte accessible. `titleId` doit désigner le titre. */
export function ModalFrame({ onClose, titleId, className, children }: { onClose: () => void; titleId: string; className: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const downOnBack = useRef(false); // fermer seulement si le clic a commencé ET fini sur le fond
  useFocusTrap(box);
  return (
    <div className="modal-back" onMouseDown={(e) => { downOnBack.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBack.current && e.target === e.currentTarget) onClose(); downOnBack.current = false; }}>
      <div ref={box} className={className} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}

/** Un identifiant stable pour relier la fenêtre à son titre. */
export function useTitleId() { return useId(); }

export function CloseButton({ onClick }: { onClick: () => void }) {
  return <button className="close" onClick={onClick} aria-label="Fermer la fenêtre"><span aria-hidden="true">×</span></button>;
}
