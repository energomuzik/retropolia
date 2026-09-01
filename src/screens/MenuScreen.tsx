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
      <div className="relative z-10 h-full max-w-xl mx-auto px-6 py-6 flex flex-col">
        {/* логотип */}
        <div className="text-center pt-6 sm:pt-10">
          <h1 className="font-pixel text-gold title-glow glow-throb leading-none text-[40px] sm:text-[58px] tracking-tight">
            RETRO<span className="text-paper">POLIA</span>
          </h1>
          <p className="mt-4 font-display text-dim uppercase tracking-[0.24em] text-[11px] sm:text-xs">
            Настольная игра, где вместо денег — твой скилл
          </p>
        </div>

        {/* меню */}
        <div className="mt-8 sm:mt-10 space-y-2.5 flex-1">
          {MENU.map((m, i) => (
            <button
              key={m.key}
              onClick={() => { sfx.coin(); setScreen(m.screen); }}
              onMouseEnter={() => { if (sel !== i) { sfx.hover(); setSel(i); } }}
              className={`menu-row w-full text-left flex items-center gap-4 px-5 py-3.5 border-2 transition-all ${
                sel === i ? 'border-edge2 bg-panel2' : 'border-transparent bg-[rgba(19,26,51,0.35)]'
              }`}
              style={{ '--rowc': m.color } as React.CSSProperties}
            >
              <span className="shrink-0" style={{ color: m.color }}>{m.icon(26)}</span>
              <span className="flex-1 min-w-0">
                <span className={`block font-display uppercase tracking-wide text-[15px] transition-colors ${sel === i ? 'text-paper' : 'text-dim'}`}>
                  {m.label}
                </span>
                <span className="block text-[10.5px] text-faint mt-0.5">{m.desc}</span>
              </span>
              {sel === i && <span className="font-pixel text-[9px] blink-hard" style={{ color: m.color }}>▶</span>}
            </button>
          ))}
        </div>

        {/* нижняя строка */}
        <div className="mt-6 mb-2 text-center space-y-2">
          <div className="font-pixel text-[9px] text-faint blink-hard">INSERT SKILL TO CONTINUE</div>
          <div className="text-[10px] text-faint">© ENERGO MUZHIK STUDIOS · v1.0.0</div>
        </div>
      </div>
    </div>
  );
}
