import { useEffect, useRef, useState } from 'react';
import type { GameView } from '@commander/engine';
import type { ChatMessage } from '../state/store.js';

export function LogPanel({ view, chat, onChat }: { view: GameView; chat: ChatMessage[]; onChat: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [stick, setStick] = useState(true);
  const count = view.log.length + chat.length;
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
              {l.text}
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
