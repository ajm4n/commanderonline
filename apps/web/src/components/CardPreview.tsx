import type { ObjectView } from '@commander/engine';
import { CardText } from './Card.js';
import { ManaCost } from './ManaCost.js';
import { coverageLabel } from '../lib/format.js';

export function CardPreview({ obj }: { obj: ObjectView | null }) {
  if (!obj || obj.hidden) return null;
  const img = obj.faceIndex > 0 && obj.backImageUri ? obj.backImageUri : obj.imageUri;
  return (
    <div className="preview">
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
