import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GameView, ObjectView } from '@commander/engine';
import type { ChatMessage } from '../state/store.js';
import type { HoverRect } from './Card.js';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Card names mentioned in the log become hoverable, so they show the large view. */
function LogText({ text, re, lookup, onHoverCard }: { text: string; re: RegExp | null; lookup: Map<string, ObjectView>; onHoverCard?: (obj: ObjectView | null, rect?: HoverRect) => void }) {
  if (!re || !onHoverCard) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const obj = lookup.get(m[0]);
    if (!obj || m.index === undefined) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span
        key={`${m.index}-${m[0]}`}
        className="log-card"
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onHoverCard(obj, { left: r.left, top: r.top, width: r.width, height: r.height });
        }}
        onMouseLeave={() => onHoverCard(null)}
      >
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (!parts.length) return <>{text}</>;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function LogPanel({ view, chat, onChat, onHoverCard }: { view: GameView; chat: ChatMessage[]; onChat: (text: string) => void; onHoverCard?: (obj: ObjectView | null, rect?: HoverRect) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [stick, setStick] = useState(true);
  const count = view.log.length + chat.length;
  const lookup = useMemo(() => {
    const m = new Map<string, ObjectView>();
    for (const o of Object.values(view.objects)) if (o && !o.hidden && o.name && !m.has(o.name)) m.set(o.name, o);
    return m;
  }, [view.objects]);
  const nameKey = useMemo(() => Array.from(lookup.keys()).sort().join('|'), [lookup]);
  const re = useMemo(() => {
    const names = Array.from(lookup.keys()).sort((a, b) => b.length - a.length);
    return names.length ? new RegExp(names.map(escapeRe).join('|'), 'g') : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameKey]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [count, stick]);
  const merged: { key: string; cls: string; text: string; at: number }[] = view.log.map((l) => ({
    key: `l${l.seq}`,
    cls: l.kind ?? (/\(manual\)/.test(l.text) ? 'manual' : ''),
    text: l.text,
    at: l.seq,
  }));
  for (const c of chat) merged.push({ key: `c${c.at}${c.from}`, cls: 'chat', text: `${c.name}: ${c.text}`, at: Number.MAX_SAFE_INTEGER });
  return (
    <div className="side-section log">
      <h3>
        <span>Log</span>
        <span className="muted">Turn {view.turn.number}</span>
      </h3>
      <div
        className="scroll grow"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        <div className="log-list">
          {merged.map((l) => (
            <div key={l.key} className={`log-line ${l.cls}`}>
              <LogText text={l.text} re={re} lookup={lookup} onHoverCard={onHoverCard} />
            </div>
          ))}
        </div>
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onChat(text);
          setText('');
        }}
      >
        <input type="text" placeholder="Chat…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="sm" type="submit">
          Send
        </button>
      </form>
    </div>
  );
}
