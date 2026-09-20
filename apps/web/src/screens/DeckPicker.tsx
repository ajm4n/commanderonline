import { useEffect, useMemo, useState } from 'react';
import type { CardData } from '@commander/engine';
import type { DeckPayload } from '@commander/protocol';
import { useStore } from '../state/store.js';
import { prepareDeckFromText, prepareDeckFromUrl, isDeckUrl, loadRecentDecks, deleteRecentDeck, computeCoverage, removeOne, deckNameFrom, type PreparedDeck, type RecentDeck } from '../lib/deck.js';
import type { ResolveProgress } from '../lib/scryfall.js';
import { coverageLabel } from '../lib/format.js';

const SAMPLE = `Commander
1 Zada, Hedron Grinder

Deck
1 Lightning Bolt
1 Sol Ring
1 Llanowar Elves
1 Giant Growth
30 Mountain
30 Forest
1 Counterspell
1 Grizzly Bears
1 Serra Angel
1 Blood Artist
1 Elvish Visionary
1 Wrath of God
1 Glorious Anthem
1 Arcane Signet
1 Command Tower
1 Swords to Plowshares
1 Cultivate
1 Rampant Growth
1 Beast Within
1 Chaos Warp
1 Rhythm of the Wild
1 Temur Battle Rage
1 Fling
1 Krenko, Mob Boss
1 Goblin Bombardment
1 Skullclamp
1 Lightning Greaves
1 Swiftfoot Boots
1 Craterhoof Behemoth
1 Avenger of Zendikar
1 Eternal Witness
1 Reclamation Sage
1 Harmonize
1 Return of the Wildspeaker
1 Rishkar's Expertise
1 Kodama's Reach
1 Farseek
1 Nature's Lore
1 Three Visits
1 Birds of Paradise
1 Fyndhorn Elves
1 Elvish Mystic
1 Wood Elves
1 Tireless Tracker
1 Etali, Primal Storm`;

export function DeckPicker() {
  const chooseDeck = useStore((s) => s.chooseDeck);
  const returnTo = useStore((s) => s.deckReturnTo);
  const hasConnection = useStore((s) => !!s.connection);
  const setScreen = (screen: 'home' | 'lobby') => useStore.setState({ screen });
  const [tab, setTab] = useState<'paste' | 'recent'>('paste');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ResolveProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedDeck | null>(null);
  const [recent, setRecent] = useState<RecentDeck[]>([]);

  useEffect(() => setRecent(loadRecentDecks()), []);

  const back = () => setScreen(hasConnection ? 'lobby' : returnTo === 'deck' ? 'home' : (returnTo as 'home' | 'lobby'));

  const run = async () => {
    setBusy(true);
    setError(null);
    setPrepared(null);
    setProgress(null);
    try {
      const t = text.trim();
      if (!t) throw new Error('Paste a decklist or a Moxfield / Archidekt URL first.');
      const result = isDeckUrl(t) ? await prepareDeckFromUrl(t) : await prepareDeckFromText(t, setProgress);
      setPrepared(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const useRecent = (r: RecentDeck) => {
    const cards = [...r.payload.commanders, ...r.payload.mainboard];
    setPrepared({ payload: r.payload, missing: [], warnings: [], coverage: computeCoverage(cards), source: 'recent' });
    setTab('paste');
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="ghost" onClick={back}>
            ◀ Back
          </button>
          <h1 style={{ margin: 0 }}>Choose a deck</h1>
        </div>
        <div className="cards-grid deck-grid">
          <div className="panel">
            <div className="tabs">
              <button className={tab === 'paste' ? 'active' : ''} onClick={() => setTab('paste')}>
                Paste list or URL
              </button>
              <button className={tab === 'recent' ? 'active' : ''} onClick={() => setTab('recent')}>
                Recent ({recent.length})
              </button>
            </div>
            {tab === 'paste' && (
              <div className="col">
                <textarea
                  value={text}
                  placeholder={'https://moxfield.com/decks/…  or  https://archidekt.com/decks/…\n\nor paste a decklist:\nCommander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n…\n\n(*CMDR* / [Commander] markers work too)'}
                  onChange={(e) => setText(e.target.value)}
                  style={{ minHeight: 260 }}
                />
                <div className="row wrap">
                  <button className="primary" disabled={busy || !text.trim()} onClick={run}>
                    {busy ? 'Loading…' : 'Load deck'}
                  </button>
                  <button className="ghost sm" disabled={busy} onClick={() => setText(SAMPLE)}>
                    Use sample list
                  </button>
                  <span className="muted small grow">Text lists resolve directly from Scryfall in your browser. URLs go through the game server.</span>
                </div>
                {progress && (
                  <div>
                    <div className="progress">
                      <div style={{ width: `${progress.total ? Math.round((100 * progress.done) / progress.total) : 0}%` }} />
                    </div>
                    <div className="muted small">
                      Resolving cards {progress.done}/{progress.total}
                    </div>
                  </div>
                )}
                {error && <div className="error">{error}</div>}
              </div>
            )}
            {tab === 'recent' && (
              <div className="list">
                {recent.length === 0 && <p className="muted small">No decks yet. Load one and it will be remembered here.</p>}
                {recent.map((r) => (
                  <div key={r.id} className="list-item clickable" onClick={() => useRecent(r)}>
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{r.payload.name}</div>
                      <div className="muted small">
                        {r.payload.commanders.map((c) => c.name).join(', ') || 'No commander'} · {r.payload.mainboard.length + r.payload.commanders.length} cards
                      </div>
                    </div>
                    <button
                      className="xs ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteRecentDeck(r.id);
                        setRecent(loadRecentDecks());
                      }}
                      title="Forget this deck"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Deck</h2>
            {!prepared && <p className="muted small">Load a deck to see its commander, card count, missing cards and how much of it the engine can automate.</p>}
            {prepared && <DeckSummary prepared={prepared} onChange={setPrepared} onUse={(p) => chooseDeck(p)} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function DeckSummary({ prepared, onChange, onUse }: { prepared: PreparedDeck; onChange: (p: PreparedDeck) => void; onUse: (p: DeckPayload) => void }) {
  const { payload, coverage, missing, warnings } = prepared;
  const total = payload.commanders.length + payload.mainboard.length;
  const [name, setName] = useState(payload.name);
  useEffect(() => setName(payload.name), [payload.name]);
  const legendaries = useMemo(() => {
    const seen = new Set<string>();
    return payload.mainboard.filter((c) => /Legendary/.test(c.typeLine) && (/Creature/.test(c.typeLine) || /can be your commander/i.test(c.oracleText)) && !seen.has(c.name) && seen.add(c.name));
  }, [payload.mainboard]);

  const applyCommanders = (commanders: CardData[], mainboard: CardData[]) => {
    const next: DeckPayload = { ...payload, commanders, mainboard, name: payload.name || deckNameFrom(commanders) };
    onChange({ ...prepared, payload: next, coverage: computeCoverage([...commanders, ...mainboard]) });
  };
  const addCommander = (card: CardData) => {
    if (payload.commanders.length >= 2) return;
    applyCommanders([...payload.commanders, card], removeOne(payload.mainboard, card));
  };
  const removeCommander = (card: CardData) => {
    applyCommanders(removeOne(payload.commanders, card), [...payload.mainboard, card]);
  };

  const pct = (n: number) => (total ? Math.round((100 * n) / total) : 0);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, fontWeight: 600 }} />
        <span className="badge">{total} cards</span>
      </div>
      <div className="deck-summary">
        <div className="commander-imgs">
          {payload.commanders.map((c, i) => (c.imageUri ? <img key={i} src={c.imageUri} alt={c.name} title={c.name} /> : <div key={i} className="card-text">{c.name}</div>))}
          {payload.commanders.length === 0 && <div className="card-text" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>No commander</div>}
        </div>
        <div className="col">
          <div>
            <div className="muted small">Commander{payload.commanders.length > 1 ? 's' : ''}</div>
            <div className="commander-list">
              {payload.commanders.map((c) => (
                <div key={c.name} className="row">
                  <span style={{ fontWeight: 600 }}>{c.name}</span>
                  <button className="xs ghost" title="Remove as commander" data-testid="remove-commander" onClick={() => removeCommander(c)}>
                    ✕
                  </button>
                </div>
              ))}
              {payload.commanders.length === 0 && <span className="muted">—</span>}
            </div>
            {legendaries.length > 0 && payload.commanders.length < 2 && (
              <select value="" data-testid="add-commander" onChange={(e) => e.target.value && addCommander(legendaries.find((c) => c.name === e.target.value)!)} style={{ marginTop: 4, maxWidth: '100%' }}>
                <option value="">{payload.commanders.length ? 'Add partner / second commander…' : 'Choose a commander…'}</option>
                {legendaries.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <div className="muted small">Automation</div>
            <div className="coverage-bar" title={`${coverage.full} automated · ${coverage.partial} partial · ${coverage.none} manual`}>
              <div className="full" style={{ width: `${pct(coverage.full)}%` }} />
              <div className="partial" style={{ width: `${pct(coverage.partial)}%` }} />
              <div className="none" style={{ width: `${pct(coverage.none)}%` }} />
            </div>
            <div className="row wrap small" style={{ marginTop: 4 }}>
              <span className="badge full">{coverage.full} automated</span>
              <span className="badge partial">{coverage.partial} partial</span>
              <span className="badge none">{coverage.none} manual</span>
            </div>
          </div>
        </div>
      </div>
      {coverage.manual.length > 0 && (
        <div>
          <div className="muted small">Cards you will resolve by hand ({coverage.manual.length})</div>
          <ul className="manual-list" style={{ padding: 0, margin: '4px 0 0' }}>
            {coverage.manual.map((m) => (
              <li key={m.name} title={m.unhandled.join('\n')}>
                <span className={`badge ${m.coverage}`} style={{ marginRight: 6 }}>
                  {coverageLabel(m.coverage)}
                </span>
                {m.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <div className="error">
          Not found ({missing.length}): {missing.join(', ')}
        </div>
      )}
      {warnings.map((w, i) => (
        <div key={i} className="warning">
          {w}
        </div>
      ))}
      {total < 60 && <div className="warning">Only {total} cards. Commander decks are 100 cards, but the game will run anyway.</div>}
      <div className="row">
        <button className="primary" disabled={total === 0} onClick={() => onUse({ ...payload, name: name.trim() || payload.name })}>
          Use this deck
        </button>
      </div>
    </div>
  );
}
