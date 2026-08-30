import { useApp } from '../store';
import { GhostBtn, Ic } from '../ui';
import type { Screen } from '../store';
import { sfx } from '../sound';

const EDITORS: { screen: Screen; label: string; desc: string; color: string; icon: (s?: number) => React.ReactNode }[] = [
  { screen: 'mapEditor', label: 'Редактор карт', desc: 'тайлы, маршрут, ячейки, их тип и оформление', color: '#2ee6a8', icon: Ic.map },
  { screen: 'tileEditor', label: 'Редактор тайлов', desc: 'загрузка, нарезка картинки, пиксельная правка', color: '#9be84d', icon: Ic.grid },
  { screen: 'taskEditor', label: 'Редактор заданий', desc: 'ромы, сохранки, картинки, бонусы и ловушки', color: '#ff8b3f', icon: Ic.cart },
  { screen: 'quizEditor', label: 'Редактор квизов', desc: 'вопросы: выбор, текст, музыка, «кот в мешке»', color: '#5aa9ff', icon: Ic.dice },
  { screen: 'tokenEditor', label: 'Редактор фишек', desc: 'свои фигурки игроков, пиксель-арт, прозрачность', color: '#ff7ad9', icon: Ic.pawn },
];

export default function EditorsHub() {
  const { setScreen } = useApp();
  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-10">
        <div className="flex items-center gap-4 mb-8">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-gold flex items-center gap-3">
            <span className="text-gold">{Ic.pen(22)}</span> Все редакторы
          </h1>
        </div>

        <div className="space-y-3">
          {EDITORS.map((e, i) => (
            <button
              key={e.screen}
              onClick={() => { sfx.click(); setScreen(e.screen); }}
              className="w-full text-left pixel-panel pixel-corners p-4 flex items-center gap-4 group transition-all hover:-translate-y-0.5 cursor-pointer slide-up"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <span
                className="w-12 h-12 shrink-0 border-[3px] border-abyss flex items-center justify-center transition-transform group-hover:scale-110"
                style={{ background: e.color, color: '#0a0c18' }}
              >
                {e.icon(22)}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block font-display uppercase tracking-wide text-paper group-hover:text-gold transition-colors">{e.label}</span>
                <span className="block text-[12px] text-dim mt-0.5">{e.desc}</span>
              </span>
              <span className="text-faint group-hover:text-gold transition-colors group-hover:translate-x-1">{Ic.play(16)}</span>
            </button>
          ))}
        </div>

        <p className="text-center text-[11px] text-faint mt-8">
          Порядок создания: тайлы → карта и ячейки → задания и квизы → фишки
        </p>
      </div>
    </div>
  );
}
