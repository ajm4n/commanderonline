import { useEffect } from 'react';
import { useStore } from './state/store.js';
import { Home } from './screens/Home.js';
import { DeckPicker } from './screens/DeckPicker.js';
import { Lobby } from './screens/Lobby.js';
import { GameScreen } from './screens/GameScreen.js';
import { Toasts } from './components/Toasts.js';

export function App() {
  const screen = useStore((s) => s.screen);
  useEffect(() => {
    // ?room=CODE deep link: auto-join once we have a name.
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    const s = useStore.getState();
    if (room && !s.connection) {
      if (!s.playerName) s.setPlayerName(`Player ${Math.floor(Math.random() * 900 + 100)}`);
      useStore.getState().joinRoom(room);
    }
  }, []);
  return (
    <>
      {screen === 'home' && <Home />}
      {screen === 'deck' && <DeckPicker />}
      {screen === 'lobby' && <Lobby />}
      {screen === 'game' && <GameScreen />}
      <Toasts />
    </>
  );
}
