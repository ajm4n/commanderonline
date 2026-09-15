import type { Decision, Response as EngineResponse } from '@commander/engine';

/**
 * Default answer for any decision — the same policy as the engine test Driver:
 * keep the hand, pass priority, never attack or block, choose the minimum.
 * Used for dummy/goldfish seats.
 */
export function defaultResponse(d: Decision): EngineResponse {
  switch (d.type) {
    case 'mulligan':
      return { type: 'mulligan', keep: true };
    case 'priority':
      return { type: 'pass' };
    case 'yesNo':
      return { type: 'yesNo', value: true };
    case 'declareAttackers':
      return { type: 'attackers', attacks: [] };
    case 'declareBlockers':
      return { type: 'blockers', blocks: [] };
    case 'chooseObjects':
      return { type: 'objects', ids: d.candidates.slice(0, d.min) };
    case 'chooseOption':
      return { type: 'options', ids: d.options.filter((o) => !o.disabled).slice(0, d.min).map((o) => o.id) };
    case 'orderObjects':
      return { type: 'order', ids: d.items ? d.items.map((i) => i.id) : d.objectIds };
    case 'chooseTargets':
      return { type: 'targets', targets: d.slots.map((s) => s.legal.slice(0, s.min)) };
    case 'chooseNumber':
      return { type: 'number', value: d.min };
    case 'distribute': {
      const amounts = d.targets.map(() => d.minPer);
      if (amounts.length) amounts[0] += d.amount - amounts.reduce((a, b) => a + b, 0);
      return { type: 'distribute', amounts };
    }
    case 'manualTrigger':
      return { type: 'manualDone' };
    case 'payMana':
      return { type: 'payMana', tap: [], auto: true };
  }
}
