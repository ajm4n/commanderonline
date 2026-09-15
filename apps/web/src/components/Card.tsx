import { memo, useState, type MouseEvent, type ReactNode } from 'react';
import type { ObjectView } from '@commander/engine';
import { cachedCard } from '../lib/scryfall.js';

export interface CardFlags {
  playable?: boolean;
  activatable?: boolean;
  legal?: boolean;
  selected?: boolean;
  dim?: boolean;
}

export interface CardProps extends CardFlags {
  obj: ObjectView;
  /** Stacked pile size (lands with the same name). */
  count?: number;
  tappedCount?: number;
  onClick?: (obj: ObjectView, e: MouseEvent) => void;
  onContextMenu?: (obj: ObjectView, e: MouseEvent) => void;
  onHover?: (obj: ObjectView | null) => void;
  children?: ReactNode;
  className?: string;
  /** Do not rotate when tapped (zone browsers). */
  noRotate?: boolean;
  showCoverage?: boolean;
}

export function colorClass(colors: string[], types: string[]): string {
  if (types.includes('Land')) return 'L';
  if (colors.length === 0) return '';
  if (colors.length > 1) return 'M';
  return colors[0];
}

/** Printed power/toughness from card data, when we know the card. */
function printedPT(obj: ObjectView): { power: number | null; toughness: number | null } | null {
  const card = cachedCard(obj.name);
  if (!card) return null;
  const face = obj.faceIndex > 0 && card.faces?.[obj.faceIndex] ? card.faces[obj.faceIndex] : card;
  const p = face.power !== undefined && /^-?\d+$/.test(face.power) ? parseInt(face.power, 10) : null;
  const t = face.toughness !== undefined && /^-?\d+$/.test(face.toughness) ? parseInt(face.toughness, 10) : null;
  if (face.power === undefined && face.toughness === undefined) return null;
  return { power: p, toughness: t };
}

export const CardText = memo(function CardText({ obj, big }: { obj: ObjectView; big?: boolean }) {
  return (
    <div className={`card-text ${colorClass(obj.colors, obj.types)} ${big ? 'big' : ''}`}>
      <div className="ct-name">{obj.name}</div>
      <div className="ct-type">{obj.typeLine}</div>
      <div className="ct-oracle">{obj.oracleText}</div>
    </div>
  );
});

export const Card = memo(function Card(props: CardProps) {
  const { obj, count, tappedCount, onClick, onContextMenu, onHover, children, className, noRotate, showCoverage } = props;
  const [imgFailed, setImgFailed] = useState(false);
  const img = obj.faceIndex > 0 && obj.backImageUri ? obj.backImageUri : obj.imageUri;
  const isCreature = obj.types.includes('Creature');
  const showPT = isCreature || (obj.power !== null && obj.toughness !== null && obj.zone === 'battlefield');
  const printed = showPT ? printedPT(obj) : null;
  const modified = printed !== null && (printed.power !== obj.power || printed.toughness !== obj.toughness);
  const negative = modified && printed !== null && ((obj.power ?? 0) < (printed.power ?? 0) || (obj.toughness ?? 0) < (printed.toughness ?? 0));
  const counters = Object.entries(obj.counters ?? {}).filter(([, n]) => n > 0);
  const cls = [
    'card',
    obj.tapped && !noRotate ? 'tapped' : '',
    obj.hidden ? 'hidden-card' : '',
    props.playable ? 'playable' : '',
    props.activatable && !props.playable ? 'activatable' : '',
    props.legal ? 'legal' : '',
    props.selected ? 'selected' : '',
    obj.attacking !== null && obj.attacking !== undefined && obj.zone === 'battlefield' ? 'attacking' : '',
    obj.blocking?.length ? 'blocking' : '',
    obj.summoningSick ? 'sick' : '',
    props.dim ? 'dim' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      data-id={obj.id}
      title={obj.hidden ? undefined : obj.name}
      onClick={(e) => onClick?.(obj, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(obj, e);
      }}
      onMouseEnter={() => onHover?.(obj)}
      onMouseLeave={() => onHover?.(null)}
    >
      {!obj.hidden && img && !imgFailed ? <img src={img} alt={obj.name} loading="lazy" draggable={false} onError={() => setImgFailed(true)} /> : !obj.hidden ? <CardText obj={obj} /> : null}
      {obj.faceDown && !obj.hidden && <span className="ov facedown">face down</span>}
      {counters.length > 0 && (
        <span className="ov counters">
          {counters.slice(0, 4).map(([k, n]) => (
            <span key={k} className={k === '+1/+1' ? 'plus' : k === '-1/-1' ? 'minus' : k === 'loyalty' ? 'loyalty' : ''} title={`${n} ${k} counter${n === 1 ? '' : 's'}`}>
              {k === '+1/+1' || k === '-1/-1' ? `${n > 0 ? k[0] : ''}${n}` : `${n} ${k.length > 6 ? k.slice(0, 5) + '…' : k}`}
            </span>
          ))}
        </span>
      )}
      {obj.isCommander && !obj.hidden && (
        <span className={`ov cmd ${obj.summoningSick ? 'with-sick' : ''}`} title="Commander">
          ★
        </span>
      )}
      {obj.summoningSick && <span className="ov sick" title="Summoning sick">💤</span>}
      {showPT && !obj.hidden && (
        <span className={`ov pt ${modified ? (negative ? 'mod neg' : 'mod') : ''}`} title={printed ? `Printed ${printed.power ?? '?'}/${printed.toughness ?? '?'}` : undefined}>
          {obj.power ?? '?'}/{obj.toughness ?? '?'}
        </span>
      )}
      {!showPT && obj.loyalty !== null && !obj.hidden && obj.zone === 'battlefield' && <span className="ov pt">{obj.loyalty}</span>}
      {obj.damage > 0 && (
        <span className="ov dmg" title={`${obj.damage} damage`}>
          {obj.damage}
        </span>
      )}
      {showCoverage && !obj.hidden && obj.coverage !== 'full' && <span className={`ov cov ${obj.coverage}`} title={obj.coverage === 'partial' ? 'Partially automated' : 'Manual card'} />}
      {count !== undefined && count > 1 && (
        <span className="ov count" title={`${count} copies${tappedCount ? `, ${tappedCount} tapped` : ''}`}>
          ×{count}
        </span>
      )}
      {count !== undefined && count > 1 && tappedCount !== undefined && tappedCount > 0 && tappedCount < count && (
        <span className="ov tapcount">
          {tappedCount}/{count} tapped
        </span>
      )}
      {children}
    </div>
  );
});
