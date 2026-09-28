import { useEffect, useState } from 'react';
import { initApp, useApp } from './store';
import { Toasts } from './ui';
import { setVolume, sfx } from './sound';
import { peekDeleted, undoLastDelete } from './delGuard';
import MenuScreen from './screens/MenuScreen';
import MapEditor from './screens/MapEditor';
import TaskEditor from './screens/TaskEditor';
import QuizEditor from './screens/QuizEditor';
import TokenEditor from './screens/TokenEditor';
import QuestEditor from './screens/QuestEditor';
import EditorsHub from './screens/EditorsHub';
import EmulatorLauncher from './screens/EmulatorLauncher';
import OptionsScreen from './screens/OptionsScreen';
import GameScreen from './screens/GameScreen';
import ChallengeWizard from './screens/ChallengeWizard';
import { CreateScreen, JoinScreen, LoadScreen, LobbyScreen } from './screens/Lobby';

export default function App() {
  const screen = useApp((s) => s.screen);
  const toasts = useApp((s) => s.toasts);
  const options = useApp((s) => s.options);
  const volume = options.volume;
  const [ready, setReady] = useState(false);

  /* v0.56: ФИЛЬТРЫ В ПОЛНОМ ЭКРАНЕ — полосатый (сканлайны) и NES NTSC — по умолчанию
     ПРОПАДАЮТ, когда эмулятор разворачивается на весь экран: полноэкранный элемент рисуется
     в отдельном «слое» браузера поверх всех fixed-оверлеев сайта. Лечим инъекцией: пока
     document.fullscreenElement существует, кладём копии фильтровых слоёв ВНУТРЬ него
     (pointer-events: none, z-index максимальный) — полосы и NTSC-эффект видны и в полном экране.
     Слои пересоздаются при изменении галочек (options.scanlines / options.ntsc). */
  useEffect(() => {
    const on = () => {
      document.querySelectorAll('.crt-fs-layer').forEach((n) => n.remove());
      const fsEl = document.fullscreenElement as HTMLElement | null;
      if (!fsEl) return;
      if (options.scanlines) {
        const d = document.createElement('div');
        d.className = 'crt-scanlines crt-fs-layer';
        d.style.zIndex = '2147483647';
        fsEl.appendChild(d);
      }
      if (options.ntscMode === 1) {
        const d = document.createElement('div');
        d.className = 'crt-ntsc crt-fs-layer';
        d.style.zIndex = '2147483646';
        fsEl.appendChild(d);
      }
      if (options.ntscMode === 2) {
        const d = document.createElement('div');
        d.className = 'crt-ntsc-soft crt-fs-layer';
        d.style.zIndex = '2147483646';
        fsEl.appendChild(d);
      }
    };
    document.addEventListener('fullscreenchange', on);
    on(); // применить к уже развёрнутому экрану (режим переключили не выходя из полного экрана)
    return () => {
      document.removeEventListener('fullscreenchange', on);
      document.querySelectorAll('.crt-fs-layer').forEach((n) => n.remove());
    };
  }, [options.scanlines, options.ntscMode]);

  useEffect(() => {
    let on = true;
    void initApp().finally(() => { if (on) setReady(true); });
    return () => { on = false; };
  }, []);

  useEffect(() => {
    setVolume(volume);
  }, [volume]);

  /* ПКМ больше НЕ открывает контекстное меню браузера — нигде в игре.
     Правая кнопка остаётся свободной для своих нужд (панорамирование карты и т.п.) */
  useEffect(() => {
    const off = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', off);
    return () => document.removeEventListener('contextmenu', off);
  }, []);

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

  /* Ctrl+Z — вернуть ПОСЛЕДНУЮ удалённую вещь (на один шаг назад).
     В полях ввода Ctrl+Z остаётся текстовой отменой браузера */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyZ') return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      const entry = peekDeleted();
      if (!entry) return;
      e.preventDefault();
      void undoLastDelete().then(async () => {
        await useApp.getState().refresh();
        useApp.getState().toast(`Возвращено: ${entry.label}`, 'ok');
        sfx.coin();
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      {screen === 'challenge' && <ChallengeWizard />}
      {screen === 'lobby' && <LobbyScreen />}
      {screen === 'game' && <GameScreen />}
      {screen === 'mapEditor' && <MapEditor />}
      {screen === 'taskEditor' && <TaskEditor />}
      {screen === 'quizEditor' && <QuizEditor />}
      {screen === 'tokenEditor' && <TokenEditor />}
      {screen === 'questEditor' && <QuestEditor />}
      {screen === 'editorsHub' && <EditorsHub />}
      {screen === 'emulator' && <EmulatorLauncher />}
      {screen === 'options' && <OptionsScreen />}
      <Toasts items={toasts} />
      {/* v0.56: полосатый фильтр; v0.57: NES NTSC — РЕЖИМОМ из общих опций
         (1 «Полосатый» — старый фильтр, 2 «Мягкий CRT» — новый, действует и на кадр эмулятора) */}
      {options.scanlines && <div className="crt-scanlines" />}
      {options.ntscMode === 1 && <div className="crt-ntsc" />}
      {options.ntscMode === 2 && <div className="crt-ntsc-soft" />}
      <div className="crt-vignette" />
    </div>
  );
}
