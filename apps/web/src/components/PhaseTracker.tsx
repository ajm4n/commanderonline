import type { GameView } from '@commander/engine';
import { STEP_ORDER, STEP_LABEL, STEP_SHORT, PHASE_OF_STEP, playerName } from '../lib/format.js';

const GROUPS: (typeof STEP_ORDER)[] = [
  STEP_ORDER.filter((s) => PHASE_OF_STEP[s] === 'beginning'),
  STEP_ORDER.filter((s) => PHASE_OF_STEP[s] === 'precombatMain'),
  STEP_ORDER.filter((s) => PHASE_OF_STEP[s] === 'combat'),
  STEP_ORDER.filter((s) => PHASE_OF_STEP[s] === 'postcombatMain'),
  STEP_ORDER.filter((s) => PHASE_OF_STEP[s] === 'ending'),
];

export function PhaseTracker({ view, compact }: { view: GameView; compact: boolean }) {
  const cur = STEP_ORDER.indexOf(view.turn.step);
  const mine = view.turn.activePlayer === view.you;
  return (
    <div className="phases" aria-label="Turn steps">
      {GROUPS.map((g, gi) => (
        <div className="phase-group" key={gi}>
          {g.map((s) => {
            const i = STEP_ORDER.indexOf(s);
            const cls = ['step', i < cur ? 'past' : '', i === cur ? 'current' : '', i === cur && !mine ? 'opp' : ''].filter(Boolean).join(' ');
            return (
              <span key={s} className={cls} title={`${STEP_LABEL[s]}${i === cur ? ` — ${playerName(view, view.turn.activePlayer)}'s turn` : ''}`}>
                {compact ? STEP_SHORT[s] : STEP_LABEL[s]}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
