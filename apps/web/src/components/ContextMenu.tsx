import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuPosition {
  x: number;
  y: number;
}

/** A floating menu anchored at a screen position, closed by outside click or Escape. */
export function ContextMenu({ at, title, onClose, children }: { at: MenuPosition; title?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(at.x, window.innerWidth - r.width - 8);
    const y = Math.min(at.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [at]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // The button that opened the menu toggles it on click; closing on its mousedown would reopen it.
      if (t?.closest?.('[data-menu-anchor]')) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="ctx" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {title && <div className="ctx-title">{title}</div>}
      {children}
    </div>
  );
}
