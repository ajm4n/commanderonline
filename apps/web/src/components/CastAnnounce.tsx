import { useEffect, useRef, useState } from 'react';
import type { GameView } from '@commander/engine';
import { CardText } from './Card.js';
import { playerName } from '../lib/format.js';

/** How long a newly announced spell or ability stays on screen. */
const HOLD_MS = 2200;

interface Announcement {
  /** Stack item id, so re-announcing the same item is a no-op. */
  id: number;
  name: string;
  who: string;
  text: string;
  kind: string;
  img: string | null;
  obj: GameView['objects'][number] | undefined;
}

/**
 * Arena-style cast announcement: whenever something is put on the stack, show the
 * card large in the middle of the screen for a moment.
 */
export function CastAnnounce({ view }: { view: GameView }) {
  const seen = useRef<Set<number>>(new Set());
  const [current, setCurrent] = useState<Announcement | null>(null);

  useEffect(() => {
    const fresh = view.stack.filter((s) => !seen.current.has(s.id));
    for (const s of view.stack) seen.current.add(s.id);
    // Drop ids that have left the stack so a re-used id still announces.
    const live = new Set(view.stack.map((s) => s.id));
    for (const id of Array.from(seen.current)) if (!live.has(id) && id !== current?.id) seen.current.delete(id);
    const last = fresh[fresh.length - 1];
    if (!last) return;
    const src = view.objects[last.sourceId];
    setCurrent({
      id: last.id,
      name: last.sourceName,
      who: playerName(view, last.controller),
      text: last.text,
      kind: last.kind,
      img: src && !src.hidden ? (src.faceIndex > 0 && src.backImageUri ? src.backImageUri : src.imageUri) ?? null : null,
      obj: src,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.stack]);

  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => setCurrent(null), HOLD_MS);
    return () => clearTimeout(t);
  }, [current]);

  if (!current) return null;
  const verb = current.kind === 'spell' ? 'casts' : current.kind === 'triggered' ? 'triggers' : 'activates';
  return (
    <div className="cast-announce" key={current.id}>
      <div className="cast-card">{current.img ? <img src={current.img} alt={current.name} /> : current.obj ? <CardText obj={current.obj} big /> : null}</div>
      <div className="cast-meta">
        <div className="cast-who">
          {current.who} {verb}
        </div>
        <div className="cast-name">{current.name}</div>
        {current.text && <div className="cast-text">{current.text}</div>}
      </div>
    </div>
  );
}
