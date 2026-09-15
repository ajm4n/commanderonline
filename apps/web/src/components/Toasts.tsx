import { useEffect } from 'react';
import { useStore } from '../state/store.js';

const TTL: Record<string, number> = { error: 7000, turn: 4000, trigger: 5000, info: 5000, success: 4000 };

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const screen = useStore((s) => s.screen);
  useEffect(() => {
    if (!toasts.length) return;
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), Math.max(500, TTL[t.kind] - (Date.now() - t.at))));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);
  if (!toasts.length) return null;
  return (
    <div className={`toasts ${screen === 'game' ? '' : 'menu'}`}>
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} role="status">
          {t.text}
        </div>
      ))}
    </div>
  );
}
