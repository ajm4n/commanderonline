import { useEffect, useState } from 'react';
import { useStore } from '../state/store.js';
import { fetchRooms, type RoomSummary } from '../lib/api.js';
import { deckSize } from '../lib/deck.js';

export function Home() {
  const name = useStore((s) => s.playerName);
  const setName = useStore((s) => s.setPlayerName);
  const startSolo = useStore((s) => s.startSolo);
  const createRoom = useStore((s) => s.createRoom);
  const joinRoom = useStore((s) => s.joinRoom);
  const openDeckPicker = useStore((s) => s.openDeckPicker);
  const deck = useStore((s) => s.deck);
  const [code, setCode] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchRooms()
        .then((r) => {
          if (!alive) return;
          setRooms(r);
          setServerOk(true);
        })
        .catch(() => {
          if (!alive) return;
          setRooms([]);
          setServerOk(false);
        });
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const ensureName = (): boolean => {
    if (name.trim()) return true;
    const n = `Planeswalker ${Math.floor(Math.random() * 900 + 100)}`;
    setName(n);
    return true;
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="hero">
          <span className="logo">Commander Online</span>
          <span className="muted">Rules-enforced Commander in the browser, with manual overrides for everything else.</span>
        </div>

        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="row wrap">
            <label className="muted">Your name</label>
            <input type="text" value={name} placeholder="Planeswalker" maxLength={24} onChange={(e) => setName(e.target.value)} style={{ width: 220 }} />
            <span className="grow" />
            <span className="muted small">Deck:</span>
            {deck ? (
              <span className="badge" title={deck.commanders.map((c) => c.name).join(', ')}>
                {deck.name} · {deckSize(deck)} cards
              </span>
            ) : (
              <span className="muted small">none selected</span>
            )}
            <button className="sm" onClick={() => openDeckPicker('home')}>
              {deck ? 'Change deck' : 'Pick a deck'}
            </button>
          </div>
        </div>

        <div className="cards-grid">
          <div className="panel">
            <h2>Solo / Goldfish</h2>
            <p className="muted small">Play against goldfish bots with the rules engine running entirely in your browser. Works offline once your deck's card data is cached.</p>
            <button
              className="primary"
              onClick={() => {
                ensureName();
                startSolo();
              }}
            >
              Start solo game
            </button>
          </div>

          <div className="panel">
            <h2>Multiplayer</h2>
            <p className="muted small">
              <span className={`status-dot ${serverOk === null ? '' : serverOk ? 'ok' : 'bad'}`} /> {serverOk === null ? 'Checking server…' : serverOk ? 'Server online' : 'Server offline — solo mode still works'}
            </p>
            <div className="col">
              <button
                className="primary"
                disabled={serverOk === false}
                onClick={() => {
                  ensureName();
                  createRoom();
                }}
              >
                Create room
              </button>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!code.trim()) return;
                  ensureName();
                  joinRoom(code);
                }}
              >
                <input type="text" placeholder="Room code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ flex: 1, textTransform: 'uppercase' }} />
                <button type="submit" disabled={!code.trim() || serverOk === false}>
                  Join
                </button>
                <button type="button" title="Watch this game as a spectator" disabled={!code.trim() || serverOk === false} onClick={() => joinRoom(code, true)}>
                  Watch
                </button>
              </form>
            </div>
          </div>

          <div className="panel">
            <h2>Open rooms</h2>
            {rooms === null && <p className="muted small">Loading…</p>}
            {rooms !== null && rooms.length === 0 && <p className="muted small">{serverOk ? 'No open rooms right now.' : 'Cannot reach the server.'}</p>}
            <div className="list">
              {(rooms ?? []).map((r) => (
                <div
                  key={r.roomId}
                  className="list-item clickable"
                  onClick={() => {
                    ensureName();
                    joinRoom(r.roomId);
                  }}
                >
                  <span className="joincode" style={{ fontSize: 14, padding: '2px 8px' }}>
                    {r.roomId}
                  </span>
                  <span className="grow small">{r.names?.join(', ') || `${r.players} player(s)`}</span>
                  <span className={`badge ${r.started ? 'partial' : 'full'}`}>{r.started ? 'in game' : 'lobby'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <p className="muted small" style={{ marginTop: 24 }}>
          Cards are automated where the engine understands them; everything else is playable Untap-style with right-click manual controls. Card images and data come from Scryfall.
        </p>
      </div>
    </div>
  );
}
