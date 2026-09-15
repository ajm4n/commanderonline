import { manaSymbols } from '../lib/format.js';

export function ManaCost({ cost }: { cost: string }) {
  const syms = manaSymbols(cost);
  if (!syms.length) return null;
  return (
    <span className="mana" title={cost}>
      {syms.map((s, i) => {
        const cls = /^[WUBRGC]$/.test(s) ? s : s.includes('/') ? s.split('/').find((c) => /^[WUBRG]$/.test(c)) ?? '' : '';
        return (
          <span key={i} className={`sym ${cls}`}>
            {s.length > 2 ? s.replace(/\//g, '') : s}
          </span>
        );
      })}
    </span>
  );
}
