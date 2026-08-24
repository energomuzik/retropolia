import { useEffect, useState } from 'react';
import { useApp } from '../store';
import type { Screen } from '../store';
import { Ic } from '../ui';
import { sfx } from '../sound';

const MENU: { key: string; label: string; screen: Screen; desc: string; color: string; icon: (s?: number) => React.ReactNode }[] = [
  { key: 'create', label: 'Создать игру', screen: 'create', desc: 'выбрать карту · открыть комнату', color: '#ffcf3f', icon: Ic.dice },
  { key: 'join', label: 'Подключиться', screen: 'join', desc: 'войти в комнату по коду', color: '#5aa9ff', icon: Ic.globe },
  { key: 'load', label: 'Загрузить игру', screen: 'load', desc: 'сохранённые партии', color: '#8f97c9', icon: Ic.save },
  { key: 'editors', label: 'Все редакторы', screen: 'editorsHub', desc: 'карты · тайлы · задания · квизы · фишки', color: '#2ee6a8', icon: Ic.pen },
  { key: 'emulator', label: 'Запуск эмулятора', screen: 'emulator', desc: 'тест ромов · запись сохранений', color: '#ff5d73', icon: Ic.chip },
  { key: 'options', label: 'Опции', screen: 'options', desc: 'имя · трансляция · звук', color: '#8f97c9', icon: Ic.gear },
];

export default function MenuScreen() {
  const { setScreen } = useApp();
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { sfx.hover(); setSel((s) => (s + 1) % MENU.length); }
      else if (e.key === 'ArrowUp') { sfx.hover(); setSel((s) => (s - 1 + MENU.length) % MENU.length); }
      else if (e.key === 'Enter') { sfx.coin(); setScreen(MENU[sel].screen); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, setScreen]);

  return (
    <div className="h-full crt-grid-bg relative overflow-hidden">
      <div className="absolute inset-0 starfield opacity-60 pointer-events-none" />
      <div className="relative z-10 h-full max-w-3xl mx-auto px-6 py-6 flex flex-col">
        {/* логотип */}
        <div className="text-center pt-2 sm:pt-4">
          <h1 className="font-pixel text-gold title-glow glow-throb leading-none text-[38px] sm:text-[56px] tracking-tight">
            RETRO<span className="text-paper">POLIA</span>
          </h1>
          <p className="mt-3 font-display text-dim uppercase tracking-[0.24em] text-[11px] sm:text-xs">
            Монополия, где вместо денег — ретро-челленджи
          </p>
        </div>

        {/* меню */}
        <nav className="flex-1 min-h-0 flex flex-col justify-center max-w-md w-full mx-auto" aria-label="Главное меню">
          {MENU.map((m, i) => (
            <button
              key={m.key}
              onMouseEnter={() => { sfx.hover(); setSel(i); }}
              onClick={() => { sfx.coin(); setScreen(m.screen); }}
              className={`menu-row flex items-center gap-4 px-4 py-[11px] text-left cursor-pointer ${sel === i ? 'active' : ''}`}
              style={{ ['--rowc' as string]: m.color }}
            >
              <span className={`shrink-0 transition-transform ${sel === i ? 'scale-110' : ''}`} style={{ color: m.color }}>
                {m.icon(22)}
              </span>
              <span className="flex-1">
                <span className={`block font-display uppercase tracking-wider text-[15px] transition-colors ${sel === i ? 'text-paper' : 'text-dim'}`}>
                  {m.label}
                </span>
                <span className="block text-[10px] font-pixel text-faint mt-0.5 lowercase">{m.desc}</span>
              </span>
              {sel === i && <span className="font-pixel text-[10px] blink-hard" style={{ color: m.color }}>▶</span>}
            </button>
          ))}
          <div className="text-center mt-5">
            <span className="font-pixel text-[9px] text-faint blink-hard">INSERT COIN TO CONTINUE</span>
          </div>
        </nav>

        {/* подвал */}
        <div className="flex items-center justify-between mt-3 pb-1 shrink-0">
          <span className="tick-label text-faint">RETROPOLIA v1.0 · локальная библиотека в IndexedDB</span>
          <span className="tick-label text-faint">© ENERGO MUZHIK STUDIOS</span>
        </div>
      </div>
    </div>
  );
}
