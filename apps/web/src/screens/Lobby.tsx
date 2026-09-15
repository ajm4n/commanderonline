import { useState } from 'react';
import { useStore } from '../state/store.js';

export function Lobby() {
  const lobby = useStore((s) => s.lobby);
  const playerId = useStore((s) => s.playerId);
  const mode = useStore((s) => s.mode);
  const connStatus = useStore((s) => s.connStatus);
  const deck = useStore((s) => s.deck);
  const openDeckPicker = useStore((s) => s.openDeckPicker);
  const setReady = useStore((s) => s.setReady);
  const startGame = useStore((s) => s.startGame);
  const addBot = useStore((s) => s.addBot);
  const updateConfig = useStore((s) => s.updateConfig);
  const leave = useStore((s) => s.leave);
  const view = useStore((s) => s.view);
  const [copied, setCopied] = useState(false);

  const me = lobby?.players.find((p) => p.id === playerId);
  const isHost = !!me?.isHost;
  const life = lobby?.config.startingLife ?? 40;
  const link = lobby ? `${location.origin}${location.pathname}?room=${encodeURIComponent(lobby.joinCode || lobby.roomId)}` : '';
  const everyoneReady = !!lobby && lobby.players.length > 0 && lobby.players.every((p) => p.ready && p.deckSize > 0 || p.name.match(/bot/i) && p.deckSize === 0 && mode === 'solo');
  const canStart = isHost && !!lobby && !lobby.started && (mode === 'solo' ? !!deck : true);

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="ghost" onClick={leave}>
            ◀ Leave
          </button>
          <h1 style={{ margin: 0 }}>{mode === 'solo' ? 'Solo game' : 'Lobby'}</h1>
          <span className="grow" />
          {mode === 'online' && <span className={`conn-pill ${connStatus}`}>{connStatus}</span>}
        </div>

        {!lobby && (
          <div className="panel">
            <p className="muted">{connStatus === 'reconnecting' || connStatus === 'connecting' ? 'Connecting to the server…' : 'Waiting for the room…'}</p>
            {connStatus === 'reconnecting' && <p className="warning">The server is not answering. Is it running on port 8787? Solo mode works without it.</p>}
          </div>
        )}

        {lobby && (
          <div className="col" style={{ gap: 16 }}>
            {mode === 'online' && (
              <div className="panel row wrap">
                <span className="muted">Join code</span>
                <span className="joincode">{lobby.joinCode || lobby.roomId}</span>
                <button
                  className="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(link).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? 'Copied!' : 'Copy invite link'}
                </button>
                <span className="muted small grow" style={{ wordBreak: 'break-all' }}>
                  {link}
                </span>
              </div>
            )}

            <div className="panel">
              <h2>Players ({lobby.players.length})</h2>
              <div className="list">
                {lobby.players.map((p) => (
                  <div key={p.id} className="lobby-player">
                    <span className={`status-dot ${!p.connected ? 'bad' : p.ready ? 'ok' : 'warn'}`} title={!p.connected ? 'disconnected' : p.ready ? 'ready' : 'not ready'} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {p.name}
                        {p.id === playerId ? ' (you)' : ''} {p.isHost && <span className="badge">host</span>}
                      </div>
                      <div className="muted small">
                        {p.deckName ? `${p.deckName}${p.deckSize ? ` · ${p.deckSize} cards` : ''}` : 'No deck yet'}
                        {p.commanders.length > 0 && ` · ${p.commanders.join(' & ')}`}
                      </div>
                    </div>
                    <span className={`badge ${p.ready ? 'full' : ''}`}>{p.ready ? 'Ready' : 'Not ready'}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel">
              <h2>Your seat</h2>
              <div className="row wrap">
                {deck ? (
                  <span className="badge" title={deck.commanders.map((c) => c.name).join(', ')}>
                    {deck.name} · {deck.commanders.length + deck.mainboard.length} cards
                  </span>
                ) : (
                  <span className="warning">Pick a deck to play.</span>
                )}
                <button className="sm" onClick={() => openDeckPicker('lobby')}>
                  {deck ? 'Change deck' : 'Pick a deck'}
                </button>
                <span className="grow" />
                {mode === 'online' && (
                  <button className={me?.ready ? '' : 'primary'} disabled={!deck} onClick={() => setReady(!me?.ready)}>
                    {me?.ready ? 'Not ready' : 'Ready'}
                  </button>
                )}
              </div>
            </div>

            {isHost && (
              <div className="panel">
                <h2>Host controls</h2>
                <div className="row wrap" style={{ marginBottom: 12 }}>
                  <label className="muted">Starting life</label>
                  <input type="number" min={1} max={999} value={life} style={{ width: 80 }} onChange={(e) => updateConfig({ startingLife: Math.max(1, Number(e.target.value) || 40) })} />
                  <button className="sm" onClick={() => addBot()} disabled={lobby.players.length >= 6}>
                    + Add bot
                  </button>
                  <span className="muted small">{mode === 'solo' ? 'Bots play a copy of your deck.' : 'Bots are goldfish seats that auto-pass.'}</span>
                </div>
                <div className="row wrap">
                  <button className="primary gold" disabled={!canStart} onClick={startGame}>
                    Start game
                  </button>
                  {!deck && <span className="warning">You need a deck first.</span>}
                  {mode === 'online' && !everyoneReady && deck && <span className="muted small">Players who are not ready will be started anyway if the server allows it.</span>}
                </div>
              </div>
            )}
            {!isHost && <p className="muted small">Waiting for the host to start the game…</p>}
            {lobby.started && !view && <p className="warning">The game has started; waiting for the board…</p>}
          </div>
        )}
      </div>
    </div>
  );
}
