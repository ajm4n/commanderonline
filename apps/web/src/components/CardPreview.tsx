import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ObjectView } from '@commander/engine';
import { CardText, type HoverRect } from './Card.js';
import { ManaCost } from './ManaCost.js';
import { coverageLabel } from '../lib/format.js';

const PREVIEW_W = 300;
/** Breathing room between the hovered card and the large view. */
const GAP = 10;
/** Used until the panel has been measured once. */
const EST_H = 540;

/**
 * Anchor the large view to the hovered card so it expands out of it (above when
 * there is room, below otherwise), rather than sitting in a fixed corner.
 */
function anchor(rect: HoverRect, height: number): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = rect.left + rect.width / 2;
  const left = Math.max(8, Math.min(cx - PREVIEW_W / 2, vw - PREVIEW_W - 8));
  const above = rect.top - GAP;
  const below = vh - (rect.top + rect.height) - GAP;
  const fitsAbove = height <= above;
  const top = fitsAbove || above >= below ? Math.max(8, rect.top - GAP - height) : Math.min(rect.top + rect.height + GAP, Math.max(8, vh - height - 8));
  return {
    left,
    top,
    bottom: 'auto',
    width: PREVIEW_W,
    maxHeight: vh - 16,
    transformOrigin: `${Math.round(cx - left)}px ${fitsAbove || above >= below ? '100%' : '0'}`,
  };
}

export function CardPreview({ obj, rect }: { obj: ObjectView | null; rect?: HoverRect | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(EST_H);
  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight);
  }, [obj?.id]);
  if (!obj || obj.hidden) return null;
  const img = obj.faceIndex > 0 && obj.backImageUri ? obj.backImageUri : obj.imageUri;
  return (
    <div className="preview" key={obj.id} ref={ref} style={rect ? anchor(rect, height) : undefined}>
      {img ? <img src={img} alt={obj.name} /> : <CardText obj={obj} big />}
      <div className="preview-text">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="name">{obj.name}</span>
          <ManaCost cost={obj.manaCost} />
        </div>
        <div className="muted small">{obj.typeLine}</div>
        <div className="row" style={{ marginTop: 4 }}>
          <span className={`badge ${obj.coverage}`}>{coverageLabel(obj.coverage)}</span>
          {obj.power !== null && obj.toughness !== null && (
            <span className="badge">
              {obj.power}/{obj.toughness}
            </span>
          )}
          {obj.loyalty !== null && <span className="badge">Loyalty {obj.loyalty}</span>}
          {obj.keywords.slice(0, 4).map((k) => (
            <span key={k} className="badge">
              {k}
            </span>
          ))}
        </div>
        {img ? null : <div className="oracle">{obj.oracleText}</div>}
        {!img && obj.abilities.length > 0 && (
          <div className="small muted" style={{ marginTop: 4 }}>
            {obj.abilities.length} scripted abilit{obj.abilities.length === 1 ? 'y' : 'ies'}
          </div>
        )}
        {obj.coverage !== 'full' && obj.unhandledText && obj.unhandledText.length > 0 && (
          <div className="unhandled">
            <div className="small">Resolve by hand:</div>
            <ul style={{ margin: '2px 0 0', padding: 0 }}>
              {obj.unhandledText.slice(0, 4).map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
