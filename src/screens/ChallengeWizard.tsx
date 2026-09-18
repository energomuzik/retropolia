import { useState } from 'react';
import { useApp } from '../store';
import { GhostBtn, Ic, PxBtn, Stepper } from '../ui';
import { idbPut, uid } from '../db';
import { challengeSummaryLines, coinsStr } from '../types';
import type { ChallengeAnswers, CellType, CustomChallenge, ResolvedChallenge } from '../types';
import { sfx } from '../sound';

/* ---------- МАСТЕР «СОЗДАТЬ ЧЕЛЛЕНДЖ» ----------
   Серия окон-вопросов: как играем (С КАРТОЙ или ВООБЩЕ БЕЗ КАРТЫ), на чём,
   какая карта, какие ячейки, РЕСУРСЫ + ШТРАФЫ И НАГРАДЫ (один шаг: время,
   попытки, МОНЕТЫ с экономикой заданий и квизов), скорость.
   Безкартовый челлендж: матчи по списку или РАНДОМАЙЗЕР (колесо фортуны)
   из выбранной папки ромов. Из ответов складываются ПРАВИЛА челленджа —
   готовый набор появляется в редакторе карт («Мои челленджи», пометка
   «СВОЙ РЕЖИМ»), а безкартовый запускается прямо из «Создания игры». */

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

const clampMin = (v: number) => Math.max(5, Math.min(180, Math.floor(v)));
const clampCoin = (v: number) => Math.max(0, Math.min(99999, Math.floor(v)));

export default function ChallengeWizard() {
  const { setScreen, toast, refresh, roms } = useApp();
  const [step, setStep] = useState(0);
  const [a, setA] = useState<ChallengeAnswers>({
    players: 'together',
    platform: 'both',
    field: 'm',
    cells: ['task', 'quiz', 'bonus', 'trap', 'rest'],
    cellAmount: 'mid',
    resTime: true,
    resTries: true,
    resCoins: false,
    startMin: 60,
    startTries: 60,
    startCoins: 100, // 1 серебряная монета
    coinsOnly: false,
    taskWinCoins: 10,
    skipCoins: 5,
    quizWinCoins: 5,
    quizLoseCoins: 5,
    penalties: false,
    loseMin: 0,
    loseTries: 0,
    winMin: 0,
    winTries: 0,
    speed: 1.2,
    mapless: false,
    maplessRandom: false,
    maplessRomIds: [],
    maplessFolder: '',
    maplessCount: 25,
  });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const upd = (p: Partial<ChallengeAnswers>) => setA((prev) => ({ ...prev, ...p }));

  const toggleCell = (key: CellType) => {
    sfx.hover();
    upd({ cells: a.cells.includes(key) ? a.cells.filter((c) => c !== key) : [...a.cells, key] });
  };

  /* Шаги мастера: первый вопрос всегда «Как играем?» — там выбор «ВООБЩЕ БЕЗ КАРТЫ»
     или игра по карте; дальше последовательность зависит от ответа */
  const STEPS: string[] = ['Как назовём челлендж?', 'Как играем?',
    ...(a.mapless
      ? ['Как выбираются игры?', 'На чём играют?', 'Ресурсы, штрафы и награды']
      : ['На чём играют?', 'Какая нужна карта?', 'Какие ячейки использовать?', 'Ресурсы, штрафы и награды', 'Как быстро ходят фишки?']),
  ];
  const stepKey = STEPS[step];

  /* папки ромов (для рандомайзера) и ромы выбранной папки */
  const folders = Array.from(new Set(roms.map((r) => r.folder ?? '')));
  const folderRoms = (folder: string) => roms.filter((r) => (folder === '' ? true : (r.folder ?? '') === folder));

  const toggleGame = (romId: string) => {
    sfx.hover();
    const list = a.maplessRomIds ?? [];
    upd({ maplessRomIds: list.includes(romId) ? list.filter((x) => x !== romId) : [...list, romId] });
  };

  const resolved = (): ResolvedChallenge => {
    const baseMode: ResolvedChallenge['baseMode'] =
      a.mapless || a.players === 'solo' ? 'journey1p' : a.players === 'together' ? 'journey' : 'classic';
    const fp = a.field === 'tiles' ? FIELD_PRESETS.m : FIELD_PRESETS[a.field];
    const coinsOn = a.resCoins;
    const poolIds = a.maplessRandom
      ? folderRoms(a.maplessFolder ?? '').map((r) => r.id)
      : (a.maplessRomIds ?? []);
    return {
      baseMode,
      mw: fp.w, mh: fp.h,
      tileMode: !a.mapless && a.field === 'tiles',
      startMin: clampMin(a.startMin),
      startTries: clampMin(a.startTries),
      resCoins: coinsOn,
      startCoins: coinsOn ? clampCoin(a.startCoins) : 0,
      coinsOnly: coinsOn && a.coinsOnly,
      taskWinCoins: coinsOn ? clampCoin(a.taskWinCoins) : 0,
      skipCoins: coinsOn ? clampCoin(a.skipCoins) : 0,
      quizWinCoins: coinsOn ? clampCoin(a.quizWinCoins) : 0,
      quizLoseCoins: coinsOn ? clampCoin(a.quizLoseCoins) : 0,
      loseMin: a.penalties ? Math.max(0, Math.min(30, a.loseMin)) : 0,
      loseTries: a.penalties ? Math.max(0, Math.min(30, a.loseTries)) : 0,
      winMin: a.penalties ? Math.max(0, Math.min(30, a.winMin)) : 0,
      winTries: a.penalties ? Math.max(0, Math.min(30, a.winTries)) : 0,
      speed: Math.round(Math.max(0.5, Math.min(6, a.speed)) * 10) / 10,
      mapless: !!a.mapless,
      maplessRandom: !!a.maplessRandom,
      maplessRomIds: poolIds,
      maplessFolder: a.maplessFolder ?? '',
      maplessCount: Math.max(1, Math.min(99, Math.floor(a.maplessCount ?? 25))),
    };
  };

  const canNext = () => {
    if (stepKey === 'Как назовём челлендж?') return name.trim().length >= 2;
    if (stepKey === 'Какие ячейки использовать?') return a.cells.length > 0;
    if (stepKey === 'Ресурсы, штрафы и награды') return a.resTime || a.resTries || a.resCoins;
    if (stepKey === 'Как выбираются игры?') {
      return a.maplessRandom
        ? folderRoms(a.maplessFolder ?? '').length > 0
        : (a.maplessRomIds ?? []).length > 0;
    }
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
      toast(
        a.mapless
          ? `Челлендж «${ch.name}» создан — запускайте его в «Создание игры», секция «Челленджи без карты»`
          : `Челлендж «${ch.name}» создан — выберите его в редакторе карт, панель «Режим игры» → «Мои челленджи»`,
        'ok',
      );
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

  const summary = challengeSummaryLines({ ...a, mapless: !!a.mapless });

  /* ---------- окно «Как выбираются игры?» (безкартовый челлендж) ---------- */
  const gamesStep = () => (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        <button
          onClick={() => { sfx.hover(); upd({ maplessRandom: false }); }}
          className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${!a.maplessRandom ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint'}`}
        >По списку</button>
        <button
          onClick={() => { sfx.hover(); upd({ maplessRandom: true }); }}
          className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${a.maplessRandom ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint'}`}
        >🎰 Рандомайзер</button>
      </div>

      {!a.maplessRandom ? (
        /* ПО СПИСКУ: выбираем игры из библиотеки ромов — по папкам, порядок = порядок кликов */
        <div className="space-y-2">
          <p className="text-[10px] text-faint leading-tight">Матчи играются ПО ПОРЯДКУ списка. Кликайте игры в нужном порядке — повторный клик убирает.</p>
          <div className="max-h-64 overflow-y-auto border-2 border-edge divide-y-2 divide-edge">
            {folders.map((f) => {
              const group = roms.filter((r) => (r.folder ?? '') === f);
              return (
                <div key={f || '__nofolder'}>
                  <div className="px-2 py-1 bg-[rgba(255,207,63,0.06)] tick-label">{f || 'Без папки'} · {group.length}</div>
                  {group.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => toggleGame(r.id)}
                      className={`w-full text-left px-2 py-1.5 text-[11px] cursor-pointer flex items-center gap-2 ${(a.maplessRomIds ?? []).includes(r.id) ? 'bg-gold/10 text-gold' : 'text-dim hover:text-paper'}`}
                    >
                      <span className="font-pixel text-[8px] w-4">{(a.maplessRomIds ?? []).includes(r.id) ? (a.maplessRomIds ?? []).indexOf(r.id) + 1 : '·'}</span>
                      <span className="truncate">{r.name}</span>
                      <span className="ml-auto font-pixel text-[7px] text-faint uppercase">{r.ext}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            {roms.length === 0 && <div className="px-2 py-3 text-[11px] text-magma">Библиотека ромов пуста — загрузите ромы в «Запуске эмулятора».</div>}
          </div>
          <div className="text-[10px] text-dim">Выбрано игр: <span className="text-gold">{(a.maplessRomIds ?? []).length}</span> — столько и будет матчей.</div>
        </div>
      ) : (
        /* РАНДОМАЙЗЕР: папка ромов + число случайных игр */
        <div className="space-y-2">
          <p className="text-[10px] text-faint leading-tight">Колесо фортуны: список игр из выбранной папки прокручивается — первый клик запускает прокрутку, второй плавно останавливает. Выпавшая игра играется.</p>
          <div>
            <div className="tick-label mb-1">Папка ромов для выбора</div>
            <select
              className="field-in w-full px-3 py-2 text-[11px] cursor-pointer"
              value={a.maplessFolder ?? ''}
              onChange={(e) => upd({ maplessFolder: e.target.value })}
            >
              <option value="">Все ромы ({roms.length})</option>
              {folders.filter((f) => f !== '').map((f) => (
                <option key={f} value={f}>{f} ({folderRoms(f).length})</option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-dim">Случайных игр до победы</span>
            <Stepper value={a.maplessCount ?? 25} onChange={(v) => upd({ maplessCount: v })} min={1} max={99} step={1} />
          </div>
          <div className="text-[10px] text-dim">В пуле: <span className="text-gold">{folderRoms(a.maplessFolder ?? '').length}</span> игр.</div>
        </div>
      )}
    </div>
  );

  /* ---------- ОБЪЕДИНЁННЫЙ ШАГ: ресурсы + штрафы и награды ---------- */
  const resourcesStep = () => (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        <button onClick={() => { sfx.hover(); upd({ resTime: !a.resTime, coinsOnly: a.resTime ? false : a.coinsOnly }); }} className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${a.resTime ? 'border-sky text-sky bg-sky/10' : 'border-edge text-faint'}`}>⏱ Время{a.resTime ? ' ✓' : ''}</button>
        <button onClick={() => { sfx.hover(); upd({ resTries: !a.resTries, coinsOnly: a.resTries ? false : a.coinsOnly }); }} className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${a.resTries ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint'}`}>🎯 Попытки{a.resTries ? ' ✓' : ''}</button>
        <button onClick={() => { sfx.hover(); upd({ resCoins: !a.resCoins, coinsOnly: a.resCoins ? false : a.coinsOnly }); }} className={`flex-1 py-2 border-2 cursor-pointer font-display text-[10px] uppercase ${a.resCoins ? 'border-teal text-teal bg-teal/10' : 'border-edge text-faint'}`}>🪙 Монеты{a.resCoins ? ' ✓' : ''}</button>
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

      {a.resCoins && (
        <div className="space-y-2 border-2 border-teal/50 px-3 py-3">
          <div className="tick-label text-teal">🪙 Монетная экономика</div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-dim">Стартовый капитал</span>
            <Stepper value={a.startCoins} onChange={(v) => upd({ startCoins: v })} min={0} max={99999} step={25} suffix=" бр" />
          </div>
          <div className="text-[9px] text-faint leading-tight">{coinsStr(a.startCoins)} · курс: 100 бронзы = 1 серебряная, 100 серебр. = 1 золотая, 100 зол. = 1 платиновая (макс. 99 плат.)</div>
          <div className="flex items-center justify-between"><span className="text-[12px] text-dim">+ за ПОБЕДУ в задании</span><Stepper value={a.taskWinCoins} onChange={(v) => upd({ taskWinCoins: v })} min={0} max={9999} step={5} suffix=" бр" /></div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-dim">Цена ПРОПУСКА задания</span>
            <Stepper value={a.skipCoins} onChange={(v) => upd({ skipCoins: v })} min={0} max={9999} step={5} suffix=" бр" />
          </div>
          <div className="text-[9px] text-faint leading-tight">0 = пропуск бесплатный. Пропуск/проигрыш списывает монеты; перезапуски игры в монетном режиме бесплатны и бесконечны.</div>
          <div className="flex items-center justify-between"><span className="text-[12px] text-dim">+ за ВЕРНЫЙ ответ квиза</span><Stepper value={a.quizWinCoins} onChange={(v) => upd({ quizWinCoins: v })} min={0} max={9999} step={5} suffix=" бр" /></div>
          <div className="flex items-center justify-between"><span className="text-[12px] text-dim">− за НЕВЕРНЫЙ ответ квиза</span><Stepper value={a.quizLoseCoins} onChange={(v) => upd({ quizLoseCoins: v })} min={0} max={9999} step={5} suffix=" бр" /></div>
          <label className="flex items-center gap-2 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={a.coinsOnly}
              onChange={(e) => { sfx.hover(); upd(e.target.checked ? { coinsOnly: true, resTime: false, resTries: false } : { coinsOnly: false }); }}
              className="accent-[#2ee6a8] w-4 h-4 cursor-pointer"
            />
            <span className="text-[11px] text-paper">Только монеты — без времени и попыток (0 монет = поражение)</span>
          </label>
        </div>
      )}

      {(a.resTime || a.resTries) && (
        <div className="space-y-2 border-2 border-edge px-3 py-3">
          <div className="flex gap-1.5">
            <button onClick={() => { sfx.hover(); upd({ penalties: false }); }} className={`flex-1 py-1.5 border-2 cursor-pointer font-display text-[9px] uppercase ${!a.penalties ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint'}`}>Без штрафов (время/попытки)</button>
            <button onClick={() => { sfx.hover(); upd({ penalties: true, loseMin: a.loseMin || 5, loseTries: a.loseTries || 0 }); }} className={`flex-1 py-1.5 border-2 cursor-pointer font-display text-[9px] uppercase ${a.penalties ? 'border-coral text-coral bg-coral/10' : 'border-edge text-faint'}`}>Со штрафами</button>
          </div>
          {a.penalties && (
            <div className="space-y-2">
              <div className="flex items-center justify-between"><span className="text-[12px] text-dim">− минут за проигрыш задания</span><Stepper value={a.loseMin} onChange={(v) => upd({ loseMin: v })} min={0} max={30} step={1} /></div>
              <div className="flex items-center justify-between"><span className="text-[12px] text-dim">− попыток за проигрыш задания</span><Stepper value={a.loseTries} onChange={(v) => upd({ loseTries: v })} min={0} max={30} step={1} /></div>
              <div className="border-t-2 border-edge pt-2" />
              <div className="flex items-center justify-between"><span className="text-[12px] text-dim">+ минут за победу (награда)</span><Stepper value={a.winMin} onChange={(v) => upd({ winMin: v })} min={0} max={30} step={1} /></div>
              <div className="flex items-center justify-between"><span className="text-[12px] text-dim">+ попыток за победу (награда)</span><Stepper value={a.winTries} onChange={(v) => upd({ winTries: v })} min={0} max={30} step={1} /></div>
            </div>
          )}
        </div>
      )}
      <p className="text-[10px] text-faint leading-tight">Комбинируйте свободно: можно только монеты, можно монеты + время, можно всё сразу. Монеты выплачиваются ПОВЕРХ времени/попыток.</p>
    </div>
  );

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
          Ответь на вопросы — из ответов соберутся правила твоего режима. Обычный челлендж появится
          в редакторе карт: панель «Режим игры» → «Мои челленджи» (пометка «СВОЙ РЕЖИМ»);
          челлендж БЕЗ КАРТЫ — в «Создании игры».
        </p>

        {/* прогресс */}
        <div className="flex items-center gap-1 mb-4">
          {STEPS.map((_, i) => (
            <span key={i} className={`h-1.5 flex-1 ${i <= step ? 'bg-gold' : 'bg-edge'}`} />
          ))}
        </div>

        <div className="pixel-panel pixel-corners p-5 pop-in">
          <div className="font-pixel text-[9px] text-faint mb-1">ВОПРОС {step + 1} ИЗ {STEPS.length}</div>
          <div className="font-display uppercase text-lg text-paper mb-4">{stepKey}</div>

          {stepKey === 'Как назовём челлендж?' && (
            <input
              autoFocus
              className="field-in w-full px-4 py-3 font-display text-lg uppercase"
              placeholder="МОЙ ЧЕЛЛЕНДЖ"
              maxLength={24}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}

          {stepKey === 'Как играем?' && (
            <div className="space-y-2">
              {opt(!!a.mapless, 'ВООБЩЕ БЕЗ КАРТЫ — только матчи-игры', () => upd({ mapless: true, players: 'solo' }), 'Игрок просто играет в игры-задания по очереди, без карты, фишек и соперников. Список игр или рандомайзер')}
              {opt(!a.mapless && a.players === 'turns', 'По карте, играют по очереди (RETROPOLIA)', () => upd({ mapless: false, players: 'turns' }), 'Кубики, ход по маршруту — классика')}
              {opt(!a.mapless && a.players === 'together', 'По карте, все играют одновременно (TRIATHLON)', () => upd({ mapless: false, players: 'together' }), 'Каждый ведёт свою фишку, кто первый пересёк ячейку задания — тот играет')}
              {opt(!a.mapless && a.players === 'solo', 'По карте, играет один — остальные зрители (JOURNEY)', () => upd({ mapless: false, players: 'solo' }), 'Одиночное приключение: подключившиеся видят трансляцию')}
            </div>
          )}

          {stepKey === 'Как выбираются игры?' && gamesStep()}

          {stepKey === 'На чём играют?' && (
            <div className="space-y-2">
              {opt(a.platform === 'phone', 'Телефон', () => upd({ platform: 'phone' }))}
              {opt(a.platform === 'pc', 'Компьютер', () => upd({ platform: 'pc' }))}
              {opt(a.platform === 'both', 'И телефон, и компьютер', () => upd({ platform: 'both' }))}
              <p className="text-[10px] text-faint leading-tight">Подсказка для автора: игра работает везде, но дженойстик/стрелки удобнее на своём устройстве.</p>
            </div>
          )}

          {stepKey === 'Какая нужна карта?' && (
            <div className="space-y-2">
              {opt(a.field === 's', FIELD_PRESETS.s.label, () => upd({ field: 's' }))}
              {opt(a.field === 'm', FIELD_PRESETS.m.label, () => upd({ field: 'm' }))}
              {opt(a.field === 'l', FIELD_PRESETS.l.label, () => upd({ field: 'l' }))}
              {opt(a.field === 'tiles', 'Плиточный режим — несколько карт-локаций', () => upd({ field: 'tiles' }), 'Карта из нескольких плиток-локаций: между ними — порталы')}
            </div>
          )}

          {stepKey === 'Какие ячейки использовать?' && (
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

          {stepKey === 'Ресурсы, штрафы и награды' && resourcesStep()}

          {stepKey === 'Как быстро ходят фишки?' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between"><span className="text-[12px] text-dim">Скорость фишек</span><Stepper value={a.speed} onChange={(v) => upd({ speed: Math.round(v * 10) / 10 })} min={0.5} max={6} step={0.1} suffix=" кл/с" /></div>
              <p className="text-[10px] text-faint leading-tight">Одинакова для всех фишек карты. Меньше — спокойнее и зрелищнее, больше — динамичнее.</p>
            </div>
          )}

          {/* навигация */}
          <div className="flex items-center justify-between gap-3 mt-6">
            <GhostBtn onClick={() => { sfx.click(); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0}>{Ic.back(12)} Назад</GhostBtn>
            {step < STEPS.length - 1 ? (
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
