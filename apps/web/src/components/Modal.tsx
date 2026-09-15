import { useEffect, type ReactNode } from 'react';

export function Modal({ title, children, onClose, wide, actions }: { title?: string; children: ReactNode; onClose?: () => void; wide?: boolean; actions?: ReactNode }) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={wide ? { minWidth: 'min(860px, 94vw)' } : undefined} role="dialog" aria-modal="true">
        {title && <h2>{title}</h2>}
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}
