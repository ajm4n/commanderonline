/** Shared helpers for damage-replacement text. */
import type { ObjectFilter } from '@commander/engine';
import { parseNoun } from './nouns.js';

/** Source side of "If <source> would deal damage …": a filter, or the ability's own object. */
export function damageSourceFilter(text: string): { filter?: ObjectFilter; selfOnly?: boolean } | null {
  const t = text.trim();
  const l = t.toLowerCase();
  if (l === '~') return { selfOnly: true };
  if (/^(?:enchanted|equipped|fortified) (?:creature|permanent|artifact|land)$/.test(l)) return { selfOnly: true };
  if (/^(?:a|any) source$/.test(l)) return { filter: undefined };
  const sm = t.match(/^(?:a|an|any|another) (.*?)\s*sources?$/i);
  if (sm) {
    const qual = sm[1].trim();
    if (!qual) return { filter: undefined };
    const noun = parseNoun(`a ${qual} card`);
    if (!noun || !noun.confident) return null;
    const f = { ...noun.filter };
    delete f.zone;
    if (/^another /i.test(t)) f.other = true;
    return { filter: f };
  }
  const noun = parseNoun(t);
  if (!noun || !noun.confident || noun.kind === 'player') return null;
  const f = { ...noun.filter };
  delete f.zone;
  if (noun.other) f.other = true;
  return { filter: f };
}

/** Destination side of "… would deal damage to <dest>". */
export function damageDestFilter(text: string): { toFilter?: ObjectFilter; toPlayers?: boolean; toObjects?: boolean; toController?: 'you' | 'opponent'; host?: 'self' | 'attachedTo' } | null {
  const t = text.trim().replace(/ this turn$/i, '');
  const l = t.toLowerCase();
  if (l === '~' || l === 'it' || l === 'itself') return { toObjects: true, toFilter: { self: true }, host: 'self' };
  if (/^(?:enchanted|equipped|fortified) (?:creature|permanent|land|artifact)$/.test(l)) return { toObjects: true, toFilter: { self: true }, host: 'attachedTo' };
  if (/^(?:a|any)(?: permanent or player| target)$/.test(l) || l === 'anything' || l === 'any target') return {};
  if (l === 'you') return { toPlayers: true, toController: 'you' };
  if (/^(?:an|any|each|target) opponent$/.test(l)) return { toPlayers: true, toController: 'opponent' };
  if (/^(?:a|any) player$/.test(l)) return { toPlayers: true };
  if (/^(?:an opponent|a player) or a permanent (?:an opponent|that player|they) controls?$/.test(l)) return { toController: 'opponent' };
  if (/^you or (?:a|an|another) (?:permanent|creature) you control$/.test(l)) return { toController: 'you' };
  const noun = parseNoun(t);
  if (!noun || !noun.confident || noun.kind === 'player') return null;
  const f = { ...noun.filter };
  delete f.zone;
  const ctrl = f.controller;
  delete f.controller;
  if (noun.other) f.other = true;
  return { toObjects: true, toFilter: f, toController: ctrl === 'you' ? 'you' : ctrl === 'opponent' ? 'opponent' : undefined };
}

/** "double that damage" / "that much damage minus 1" / "half that damage, rounded down" / "3 damage". */
export function damageModifier(text: string): { setTo?: number; times?: number; plus?: number; minus?: number; half?: 'up' | 'down' } | null {
  let t = text.trim().toLowerCase().replace(/ instead$/, '').trim();
  t = t.replace(/,? to (?:that|those|it|itself|them|you|~|its controller|each of those|equipped \w+|enchanted \w+)[\w' ]*$/, '').replace(/,$/, '').trim();
  let mm: RegExpMatchArray | null;
  if (/^(?:double|twice) (?:that|that much|this) damage$/.test(t) || /^twice that much damage$/.test(t)) return { times: 2 };
  if (/^(?:triple|three times) (?:that|that much) damage$/.test(t)) return { times: 3 };
  if ((mm = t.match(/^(?:that much |that )?damage plus (\d+)$/))) return { plus: parseInt(mm[1], 10) };
  if ((mm = t.match(/^(?:that much |that )?damage minus (\d+)$/))) return { minus: parseInt(mm[1], 10) };
  if ((mm = t.match(/^half (?:that|that much) damage,? rounded (up|down)$/))) return { half: mm[1] === 'up' ? 'up' : 'down' };
  if ((mm = t.match(/^(\d+) damage$/))) return { setTo: parseInt(mm[1], 10) };
  return null;
}
