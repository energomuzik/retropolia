import { useState } from 'react';
import { useApp } from '../store';
import { GhostBtn, Ic, PxBtn, Stepper } from '../ui';
import { idbPut, uid } from '../db';
import { challengeSummaryLines } from '../types';
import type { ChallengeAnswers, CellType, CustomChallenge, ResolvedChallenge } from '../types';
import { sfx } from '../sound';

/* ---------- МАСТЕР «СОЗДАТЬ ЧЕЛЛЕНДЖ» ----------
   Серия окон-вопросов: как играем, на чём, какая карта, какие ячейки, ресурсы,
   штрафы и награды, скорость. Из ответов складываются ПРАВИЛА челленджа — готовый
   набор появляется в редакторе карт в панели «Режим игры» с пометкой «СВОЙ РЕЖИМ». */

const FIELD_PRESETS: Record<Exclude<ChallengeAnswers['field'], 'tiles'>, { w: number; h: number; label: string }> = {
  s: { w: 1280, h: 960, label: 'Малая (1280×960)' },
  m: { w: 2048, h: 1536, label: 'Средняя (2048×1536)' },
  l: { w: 3200, h: 2400, label: 'Большая (3200×2400)' },
};

const CELL_OPTS: { key: CellType; label: string }[] = [
  { key: 'task', label: 'Задания (ромы)' },
  { key: 'quiz', label: 'Квизы' },
  { key: 'bonus', label: 'Бонусы' },
  { key: 'trap', label: 'Штрафы-ловушки' },
  { key: 'rest', label: 'Передышки' },
];

const QUESTIONS = [
  'Как назовём челлендж?',
  'Кто играет?',
  'На чём играют?',
  'Какая нужна карта?',
  'Какие ячейки использовать?',
  'Какие ресурсы у игрока?',
  'Нужны ли штрафы и награды?',
  'Как быстро ходят фишки?',
];

export default function ChallengeWizard() {
  const { setScreen, toast, refresh } = useApp();
  const [step, setStep] = useState(0);
  const [a, setA] = useState<ChallengeAnswers>({
    players: 'together',
    platform: 'both',
    field: 'm',
    cells: ['task', 'quiz', 'bonus', 'trap', 'rest'],
    cellAmount: 'mid',
    resTime: true,
    resTries: true,
    startMin: 60,
    startTries: 60,
    penalties: false,
    loseMin: 0,
    loseTries: 0,
    winMin: 0,
    winTries: 0,
    speed: 1.2,
  });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const upd = (p: Partial<ChallengeAnswers>) => setA((prev) => ({ ...prev, ...p }));

  const toggleCell = (key: CellType) => {
    sfx.hover();
    upd({ cells: a.cells.includes(key) ? a.cells.filter((c) => c !== key) : [...a.cells, key] });
  };

  const resolved = (): ResolvedChallenge => {
    const baseMode: ResolvedChallenge['baseMode'] =
      a.players === 'solo' ? 'journey1p' : a.players === 'together' ? 'journey' : 'classic';
    const fp = a.field === 'tiles' ? FIELD_PRESETS.m : FIELD_PRESETS[a.field];
    return {
      baseMode,
      mw: fp.w, mh: fp.h,
      tileMode: a.field === 'tiles',
      startMin: Math.max(5, Math.min(180, a.startMin)),
      startTries: Math.max(5, Math.min(180, a.startTries)),
      loseMin: a.penalties ? Math.max(0, Math.min(30, a.loseMin)) : 0,
      loseTries: a.penalties ? Math.max(0, Math.min(30, a.loseTries)) : 0,
      winMin: a.penalties ? Math.max(0, Math.min(30, a.winMin)) : 0,
      winTries: a.penalties ? Math.max(0, Math.min(30, a.winTries)) : 0,
      speed: Math.round(Math.max(0.5, Math.min(6, a.speed)) * 10) / 10,
    };
  };

  const canNext = () => {
    if (step === 0) return name.trim().length >= 2;
    if (step === 4) return a.cells.length > 0;
    if (step === 5) return a.resTime || a.resTries;
    return true;
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ch: CustomChallenge = {
        id: uid('chal'),
        name: name.trim().toUpperCase(),
        answers: { ...a },
        resolved: resolved(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await idbPut('challenges', ch.id, ch);
      await refresh();
      sfx.success();
      toast(`Челлендж «${ch.name}» создан — выберите его в редакторе карт, панель «Режим игры» → «Мои челленджи»`, 'ok');
      setScreen('menu');
    } catch {
      toast('Не удалось сохранить челлендж', 'err');
    } finally {
      setBusy(false);
    }
  };

  const opt = (on: boolean, label: string, onClick: () => void, hint?: string) => (
    <button
      onClick={() => { sfx.hover(); onClick(); }}
      title={hint}
      className={`w-full text-left border-2 px-3 py-2.5 cursor-pointer transition-colors ${on ? 'border-gold bg-gold/10' : 'border-edge bg-panel hover:border-edge2'}`}
    >
      <span className={`font-display text-[12px] uppercase ${on ? 'text-gold' : 'text-paper'}`}>{on ? '✓ ' : ''}{label}</span>
    </button>
  );

  const summary = challengeSummaryLines(a);

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-2">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-[#ff8b3f] flex items-center gap-3">
            <span>{Ic.trophy(22)}</span> Создать челлендж
          </h1>
        </div>
        <p className="text-[12px] text-dim mb-4">
          Ответь на вопросы — из ответов соберутся правила твоего режима. Готовый челлендж появится
          в редакторе карт: панель «Режим игры» → «Мои челленджи» (пометка «СВОЙ РЕЖИМ»).
        </p>

        {/* прогресс */}
        <div className="flex items-center gap-1 mb-4">
          {QUESTIONS.map((_, i) => (
            <span key={i} className={`h-1.5 flex-1 ${i <= step ? 'bg-gold' : 'bg-edge'}`} />
          ))}
        </div>

        <div className="pixel-panel pixel-corners p-5 pop-in">
          <div className="font-pixel text-[9px] text-faint mb-1">ВОПРОС {step + 1} ИЗ {QUESTIONS.length}</div>
          <div className="font-display uppercase text-lg text-paper mb-4">{QUESTIONS[step]}</div>

          {step === 0 && (
            <input
              autoFocus
              className="field-in w-full px-4 py-3 font-display text-lg uppercase"
              placeholder="МОЙ ЧЕЛЛЕНДЖ"
              maxLength={24}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}

          {step === 1 && (
            <div className="space-y-2">
              {opt(a.players === 'turns', 'Играют по очереди (RETROPOLIA)', () => upd({ players: 'turns' }), 'Кубики, ход по маршруту — классика')}
              {opt(a.players === 'together', 'Все играют одновременно (TRIATHLON)', () => upd({ players: 'together' }), 'Каждый ведёт свою фишку, кто первый пересёк ячейку задания — тот играет')}
              {opt(a.players === 'solo', 'Играет один, остальные — зрители (JOURNEY)', () => upd({ players: 'solo' }), 'Одиночное приключение: подключившиеся видят трансляцию')}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-2">
              {opt(a.platform === 'phone', 'Телефон', () => upd({ platform: 'phone' }))}
              {opt(a.platform === 'pc', 'Компьютер', () => upd({ platform: 'pc' }))}
              {opt(a.platform === 'both', 'И телефон, и компьютер', () => upd({ platform: 'both' }))}
              <p className="text-[10px] text-faint leading-tight">Подсказка для автора: игра работает везде, но дженойстик/стрелки удобнее на своём устройстве.</p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-2">
              {opt(a.field === 's', FIELD_PRESETS.s.label, () => upd({ field: 's' }))}
              {opt(a.field === 'm', FIELD_PRESETS.m.label, () => upd({ field: 'm' }))}
              {opt(a.field === 'l', FIELD_PRESETS.l.label, () => upd({ field: 'l' }))}
              {opt(a.field === 'tiles', 'Плиточный режим — несколько карт-локаций', () => upd({ field: 'tiles' }), 'Карта из нескольких плиток-локаций: между ними — порталы')}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                {CELL_OPTS.map((o) => (
                  <button
                    key={o.key}
                    onClick={() => toggleCell(o.key)}
                    className={`w-full text-left border-2 px-3 py-2 cursor-pointer transition-colors ${a.cells.includes(o.key) ? 'border-gold bg-gold/10' : 'border-edge bg-panel hover:border-edge2'}`}
                  >
                    <span className={`font-display text-[12px] ${a.cells.includes(o.key) ? 'text-gold' : 'text-paper'}`}>{a.cells.includes(o.key) ? '✓ ' : '· '}{o.label}</span>
                  </button>
                ))}
              </div>
              <div>
                <div className="tick-label mb-1.5">Сколько ячеек ориентировочно?</div>
                <div className="flex gap-1.5">
                  {(['few', 'mid', 'many'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => { sfx.hover(); upd({ cellAmount: k }); }}
                      className={`flex-1 py-1.5 border-2 cursor-pointer font-display text-[9px] uppercase ${a.cellAmount === k ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint hover:text-dim'}`}
                    >{k === 'few' ? 'Немного' : k === 'mid' ? 'Средне' : 'Много'}</button>
                  ))}
                </div>
                {a.cells.length === 0 && <p className="text-[10px] text-magma mt-2">Выберите хотя бы один тип ячеек.</p>}
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3">
              <div className="flex gap-1.5">
                <button onClick={() => { sfx.hover(); upd({ resTime: !a.resTime }); }} className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${a.resTime ? 'border-sky text-sky bg-sky/10' : 'border-edge text-faint'}`}>⏱ Время{a.resTime ? ' ✓' : ''}</button>
                <button onClick={() => { sfx.hover(); upd({ resTries: !a.resTries }); }} className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${a.resTries ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint'}`}>🎯 Попытки{a.resTries ? ' ✓' : ''}</button>
              </div>
              {(a.resTime || a.resTries) && (
                <div className="space-y-2">
                  {a.resTime && (
                    <div className="flex items-center justify-between"><span className="text-[12px] text-dim">Минут у игрока</span><Stepper value={a.startMin} onChange={(v) => upd({ startMin: v })} min={5} max={180} step={5} /></div>
                  )}
                  {a.resTries && (
                    <div className="flex items-center justify-between"><span className="text-[12px] text-dim">Попыток у игрока</span><Stepper value={a.startTries} onChange={(v) => upd({ startTries: v })} min={5} max={180} step={5} /></div>
                  )}
                </div>
              )}
              <p className="text-[10px] text-faint leading-tight">В будущем добавим другие ресурсы — пока челлендж использует время и попытки.</p>
            </div>
          )}

          {step === 6 && (
            <div className="space-y-3">
              <div className="flex gap-1.5">
                <button onClick={() => { sfx.hover(); upd({ penalties: false }); }} className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${!a.penalties ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint'}`}>Без штрафов</button>
                <button onClick={() => { sfx.hover(); upd({ penalties: true, loseMin: a.loseMin || 5, loseTries: a.loseTries || 0 }); }} className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${a.penalties ? 'border-coral text-coral bg-coral/10' : 'border-edge text-faint'}`}>Со штрафами</button>
              </div>
              {a.penalties && (
                <div className="space-y-2 border-2 border-edge px-3 py-3">
                  <div className="flex items-center justify-between"><span className="text-[12px] text-dim">− минут за проигрыш задания</span><Stepper value={a.loseMin} onChange={(v) => upd({ loseMin: v })} min={0} max={30} step={1} /></div>
                  <div className="flex items-center justify-between"><span className="text-[12px] text-dim">− попыток за проигрыш задания</span><Stepper value={a.loseTries} onChange={(v) => upd({ loseTries: v })} min={0} max={30} step={1} /></div>
                  <div className="border-t-2 border-edge pt-2" />
                  <div className="flex items-center justify-between"><span className="text-[12px] text-dim">+ минут за победу (награда)</span><Stepper value={a.winMin} onChange={(v) => upd({ winMin: v })} min={0} max={30} step={1} /></div>
                  <div className="flex items-center justify-between"><span className="text-[12px] text-dim">+ попыток за победу (награда)</span><Stepper value={a.winTries} onChange={(v) => upd({ winTries: v })} min={0} max={30} step={1} /></div>
                </div>
              )}
            </div>
          )}

          {step === 7 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between"><span className="text-[12px] text-dim">Скорость фишек</span><Stepper value={a.speed} onChange={(v) => upd({ speed: Math.round(v * 10) / 10 })} min={0.5} max={6} step={0.1} suffix=" кл/с" /></div>
              <p className="text-[10px] text-faint leading-tight">Одинакова для всех фишек карты. Меньше — спокойнее и зрелищнее, больше — динамичнее.</p>
            </div>
          )}

          {/* навигация */}
          <div className="flex items-center justify-between gap-3 mt-6">
            <GhostBtn onClick={() => { sfx.click(); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0}>{Ic.back(12)} Назад</GhostBtn>
            {step < QUESTIONS.length - 1 ? (
              <PxBtn color="gold" disabled={!canNext()} onClick={() => { sfx.click(); setStep((s) => s + 1); }}>Далее {Ic.play(12)}</PxBtn>
            ) : (
              <PxBtn color="gold" disabled={!name.trim() || busy} onClick={() => void create()}>{Ic.trophy(14)} Создать челлендж</PxBtn>
            )}
          </div>
        </div>

        {/* сводка ответов */}
        {step > 0 && (
          <div className="mt-4 border-2 border-edge px-4 py-3">
            <div className="tick-label mb-2">Ваши ответы — челлендж «{name.trim() || '…'}»</div>
            <ul className="space-y-1">
              {summary.map((line, i) => (
                <li key={i} className="text-[11px] text-dim leading-snug flex gap-2"><span className="text-gold font-pixel text-[8px] pt-0.5">▸</span>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
