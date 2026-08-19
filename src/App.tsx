import { useEffect, useState } from 'react';
import { initApp, useApp } from './store';
import { Toasts } from './ui';
import { setVolume } from './sound';
import MenuScreen from './screens/MenuScreen';
import TileEditor from './screens/TileEditor';
import MapEditor from './screens/MapEditor';
import TaskEditor from './screens/TaskEditor';
import TokenEditor from './screens/TokenEditor';
import EmulatorLauncher from './screens/EmulatorLauncher';
import OptionsScreen from './screens/OptionsScreen';
import GameScreen from './screens/GameScreen';
import { CreateScreen, JoinScreen, LoadScreen, LobbyScreen } from './screens/Lobby';

export default function App() {
  const screen = useApp((s) => s.screen);
  const toasts = useApp((s) => s.toasts);
  const volume = useApp((s) => s.options.volume);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let on = true;
    void initApp().finally(() => { if (on) setReady(true); });
    return () => { on = false; };
  }, []);

  useEffect(() => {
    setVolume(volume);
  }, [volume]);

  useEffect(() => {
    const on = (e: GamepadEvent) => useApp.getState().toast(`Джойстик подключён: ${e.gamepad.id.slice(0, 40)}`, 'ok');
    const off = () => useApp.getState().toast('Джойстик отключён', 'info');
    window.addEventListener('gamepadconnected', on);
    window.addEventListener('gamepaddisconnected', off);
    return () => {
      window.removeEventListener('gamepadconnected', on);
      window.removeEventListener('gamepaddisconnected', off);
    };
  }, []);

  if (!ready) {
    return (
      <div className="h-full crt-grid-bg flex flex-col items-center justify-center gap-5">
        <div className="font-pixel text-gold text-xl title-glow glow-throb">RETROPOLIA</div>
        <div className="font-pixel text-[9px] text-dim blink-hard">LOADING CARTRIDGE…</div>
        <div className="w-52 h-3 border-2 border-edge bg-panel overflow-hidden">
          <div className="h-full bg-gold marquee-x" style={{ width: '40%' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      {screen === 'menu' && <MenuScreen />}
      {screen === 'create' && <CreateScreen />}
      {screen === 'join' && <JoinScreen />}
      {screen === 'load' && <LoadScreen />}
      {screen === 'lobby' && <LobbyScreen />}
      {screen === 'game' && <GameScreen />}
      {screen === 'mapEditor' && <MapEditor />}
      {screen === 'tileEditor' && <TileEditor />}
      {screen === 'taskEditor' && <TaskEditor />}
      {screen === 'tokenEditor' && <TokenEditor />}
      {screen === 'emulator' && <EmulatorLauncher />}
      {screen === 'options' && <OptionsScreen />}
      <Toasts items={toasts} />
      <div className="crt-scanlines" />
      <div className="crt-vignette" />
    </div>
  );
}
