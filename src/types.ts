export type CellType = 'start' | 'task' | 'rest' | 'bonus' | 'trap' | 'quiz'; // rest — пустая клетка-передышка: ничего не происходит, ром не нужен

/* ---------- Типы сохранений (кнопки в «Запуске эмулятора») ----------
   level — «Уровень N» (обычные точки заданий), boss — «Босс N»,
   mytask — единственное на ром «Моё задание» (перезаписывается),
   private — «Назови меня N» (создатель переименовывает; в игре НЕ выбирается,
   доступно только в редакторе заданий). Старые сохранения без kind = level. */
export type SaveKind = 'level' | 'boss' | 'mytask' | 'private';
export const SAVE_KIND_LABEL: Record<SaveKind, string> = {
  level: 'Уровни',
  boss: 'Боссы',
  mytask: 'Моё задание',
  private: 'Частные (только в редакторе заданий)',
};
export const SAVE_KIND_SHORT: Record<SaveKind, string> = {
  level: 'УРОВЕНЬ',
  boss: 'БОСС',
  mytask: 'МОЁ ЗАДАНИЕ',
  private: 'ЧАСТНОЕ',
};
export const SAVE_KIND_CLS: Record<SaveKind, string> = {
  level: 'bg-gold/15 text-gold',
  boss: 'bg-coral/15 text-coral',
  mytask: 'bg-teal/15 text-teal',
  private: 'bg-sky/15 text-sky',
};
export const saveKindOf = (s: { kind?: SaveKind }): SaveKind => s.kind ?? 'level';
/** Номер из подписи сохранения («Уровень 3» → 3, «Уровень ~7» → 7, «Моё задание» → 0). */
export const saveKindNum = (s: { name: string }): number => {
  const m = s.name.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
};

export interface PlacedTile {
  x: number;
  y: number;
  tileId: string;
  rot: number; // 0..3, шаги по 90°
}

export interface TaskDef {
  romId: string;
  saveId?: string; // для SEGA-ромов слот необязателен — ядро стартует с начала
  title: string;
  desc: string;
  imageId?: string; // ключ в blobs
  chaos?: ChaosKind; // пакость: искажение эмулятора/правила, пока задание активно (1 максимум)
  joy?: JoyId; // радость: награда прошедшему задание (1 максимум)
}

export interface CellDef {
  n: number; // номер на карте (1-based, по порядку создания). Движку не нужен — путь задаётся порядком и стрелками
  x: number;
  y: number;
  w?: number; // ШИРИНА В КЛЕТКАХ — только для СТАРЫХ карт (сетка 64px)
  h?: number;
  type: CellType;
  task?: TaskDef | null;
  // свободное размещение (новые карты): центр и размер в ПИКСЕЛЯХ поля — без привязки к сетке
  cx?: number; // центр X, px
  cy?: number; // центр Y, px
  cw?: number; // ширина, px (по умолчанию 64)
  ch?: number; // высота, px (по умолчанию 64)
  next?: number; // стрелка «дорога»: у БЕЗНОМЕРНОЙ ячейки — куда шагает фишка; у ПРОНУМЕРОВАННОЙ — прыжок при ОСТАНОВКЕ на ней. Нет — авто (следующая по массиву, по кругу)
  hop?: number; // ВТОРАЯ стрелка «переход» (коралловая): фишка, ОСТАНОВИВШАЯСЯ на ячейке, прыгает по ней — выход из круга, штраф-телепорт. Проходом мимо не срабатывает
  nextStyle?: ArrowStyle; // оформление стрелки «дорога»: толщина/цвет/пунктир/наконечник
  hopStyle?: ArrowStyle;  // оформление стрелки «переход»
  nonumber?: boolean; // ячейка БЕЗ НОМЕРА (клетка круга/закоулка): основной путь по номерам её ПЕРЕСКАКИВАЕТ, попасть можно только по стрелке
  nextTag?: 'in' | 'out'; // (устарело) метки закоулков v0.12.x — при открытии карты конвертируются в nonumber/next
  // задание не назначено — предупреждение
  // оформление «как в монополии»: цвет группы, короткое имя, картинка
  label?: string;
  color?: string;
  imageId?: string; // dataURL картинки ячейки (видна на карте)
}

/* Оформление стрелки на карте: толщина, цвет, пунктир, наконечник-остриё.
   Всё необязательно: по умолчанию — жирная (8px) сплошная с остриём, стандартного цвета. */
export interface ArrowStyle {
  w?: number;     // толщина линии в px (по умолчанию 8, максимум 24)
  col?: string;   // свой цвет; нет — стандартный (золотая «дорога» / коралловый «переход»)
  dash?: boolean; // рисовать пунктиром
  head?: boolean; // наконечник-остриё на конце (по умолчанию включён)
  over?: boolean; // стрелка ЗАХОДИТ на ячейку (по умолчанию да); нет — останавливается У КРАЯ ячейки, не налезая на неё
}

export type QuizType = 'choice' | 'text' | 'music' | 'mystery' | 'order';

/* Пункт квиза «расставь по порядку»: в items лежат пункты в ПРАВИЛЬНОМ порядке (сверху вниз) */
export interface QuizOrderItem {
  text: string;
  image?: string; // dataUrl картинки пункта (необязательно)
}

export interface QuizDef {
  id: string;
  type: QuizType;
  question: string;
  imageId?: string; // dataURL картинки вопроса
  options?: string[]; // 4 варианта для choice/music/mystery
  correct?: number; // индекс правильного варианта
  answers?: string[]; // допустимые написания ответа (text)
  items?: QuizOrderItem[]; // для order: 4 пункта в ПРАВИЛЬНОМ порядке сверху вниз; игрок расставляет их сам
  audioId?: string; // dataURL мелодии (music)
  timeLimit: number; // секунды на ответ
  continueOnCorrect?: boolean; // верный ответ не завершает квиз — остальные тоже отвечают
  noPenalty?: boolean; // неверный ответ не отнимает ресурсы
  createdAt: number;
}

export interface QuizRun {
  quizId: string;
  askerId: string; // кто встал на ячейку
  targetId: string; // кто отвечает («кот в мешке» может передать)
  startedAt: number;
  resolved: boolean;
  answered?: { id: string; name: string }[]; // ошибившиеся игроки (в гонке отвечают один раз)
  pending?: { id: string; name: string; sentAt: number }[]; // верные ответы в «окне сбора»
  correctBy?: string[]; // уже ответили верно (режим «квиз продолжается») — повторно не отвечают
  result?: {
    correct: boolean;
    deltaMin: number;
    deltaTries: number;
    targetName: string;
    reason: 'correct' | 'allWrong' | 'timeout';
    winners?: string[]; // в режиме «квиз продолжается» — все, кто ответил верно
  };
}

export type EffectType =
  | 'move' // сдвиг по треку на value (вперёд/назад)
  | 'teleport' // переход на ячейку с номером value
  | 'jail' // «отпуск»: пропуск value ходов
  | 'wrongway' // «не туда»: прыжок на случайную ячейку-ловушку/бонус, иначе назад
  | 'extraTurn' // доп. ход текущего
  | 'skipTurn' // пропуск хода текущего
  | 'playerExtra' // доп. ход игрока target
  | 'playerSkip' // пропуск хода игрока target
  | 'addMin' | 'subMin' // минуты текущему
  | 'addTries' | 'subTries' // попытки текущему
  | 'toInventory' // карточка НЕ срабатывает сразу — ложится в инвентарь игрока
  | 'diePlus' // радость: следующий бросок — 3 кубика
  | 'addMinTries' // радость: +value минут И +value попыток
  | 'freeSkip' // радость: пропуск любого задания без платы (флаг игрока)
  | 'immuneSega' // радость: иммунитет к SEGA-заданию
  | 'immuneNes'; // радость: иммунитет к NES-заданию

export interface CardEffect {
  type: EffectType;
  value: number;
  target: number; // 1-based номер игрока (для playerExtra/playerSkip)
}

export interface CardDef {
  id: string;
  kind: 'bonus' | 'trap' | 'joy';
  name: string;
  desc: string;
  imageId?: string;
  effect: CardEffect;
  chaos?: ChaosKind; // у пакостной карточки: что именно искажать в эмуляторе
}

/* ---------- Пакости: искажения эмулятора для заданий ---------- */

export type ChaosKind =
  | 'grayscale' | 'flip' | 'mirror' | 'blur' | 'invertPad' // blur — устарела (бывшая «Туман»), оставлена для старых сохранений
  | 'curtainTop10' | 'curtainTop20' | 'curtainTop50'
  | 'curtainBottom10' | 'curtainBottom20' | 'curtainBottom50'
  | 'curtainLeft10' | 'curtainLeft20' | 'curtainLeft50'
  | 'curtainRight10' | 'curtainRight20' | 'curtainRight50'
  | 'pal50' | 'speed150' | 'speed200' | 'speed300' | 'lagButtons'
  | 'scrollH1' | 'scrollH2' | 'scrollV1' | 'scrollV2' // прокрутка экрана — УДАЛЕНА (легаси, игнорируется)
  | 'static' | 'vhs' // помехи / VHS-плёнка
  | 'skipX2' | 'noReward' | 'halfWin' | 'dice0' | 'oneDie'; // пакости-правила

export const CHAOS_LIST: { kind: ChaosKind; name: string; desc: string }[] = [
  { kind: 'grayscale', name: 'Чёрно-белый экран', desc: 'Картинка теряет цвета — квест «а где же красная платформа?»' },
  { kind: 'flip', name: 'Вверх ногами', desc: 'Экран переворачивается на 180° — играйте, наклонив голову' },
  { kind: 'mirror', name: 'Зеркало', desc: 'Картинка отражается по горизонтали' },
  { kind: 'noReward', name: 'Без очков', desc: 'Прошёл задание — и ничего: ячейка НЕ захватывается, ресурсы не возвращаются' },
  { kind: 'halfWin', name: 'Половина победы', desc: 'Задание пройдено, но ячейка НЕ захватывается — вернётся лишь половина потраченных ресурсов' },
  { kind: 'skipX2', name: 'Штраф ×2', desc: 'Пропуск задания стоит вдвое дороже: не 5, а 10 ресурсов' },
  { kind: 'dice0', name: 'Кубики-0', desc: 'Вставший на ячейку бросает 0 и застревает, пока не пройдёт задание. Прошедший и заменивший его снимает проклятие для остальных' },
  { kind: 'oneDie', name: 'Один кубик', desc: 'Следующий бросок вставшего на ячейку — только ОДИН кубик; бонус «+1 кубик» применять нельзя' },
  { kind: 'static', name: 'Помехи', desc: 'Экран шипит белыми помехами и рвётся полосами — как телевизор с плохой антенной' },
  { kind: 'vhs', name: 'VHS-плёнка', desc: 'Затёртая кассета: полосы трекинга, рябь, выцветший цвет и виньетка по краям' },
  { kind: 'invertPad', name: 'Реверс крестовины', desc: 'Влево едет вправо, вверх едет вниз' },
  { kind: 'curtainTop10', name: 'Шторка сверху 10%', desc: 'Чёрная шторка закрывает верх экрана на 10%' },
  { kind: 'curtainTop20', name: 'Шторка сверху 20%', desc: 'Чёрная шторка закрывает верх экрана на 20%' },
  { kind: 'curtainTop50', name: 'Шторка сверху 50%', desc: 'Чёрная шторка закрывает ПОЛОВИНУ верха экрана' },
  { kind: 'curtainBottom10', name: 'Шторка снизу 10%', desc: 'Чёрная шторка закрывает низ экрана на 10%' },
  { kind: 'curtainBottom20', name: 'Шторка снизу 20%', desc: 'Чёрная шторка закрывает низ экрана на 20%' },
  { kind: 'curtainBottom50', name: 'Шторка снизу 50%', desc: 'Чёрная шторка закрывает ПОЛОВИНУ низа экрана' },
  { kind: 'curtainLeft10', name: 'Шторка слева 10%', desc: 'Чёрная шторка закрывает левый край на 10%' },
  { kind: 'curtainLeft20', name: 'Шторка слева 20%', desc: 'Чёрная шторка закрывает левый край на 20%' },
  { kind: 'curtainLeft50', name: 'Шторка слева 50%', desc: 'Чёрная шторка закрывает ПОЛОВИНУ слева' },
  { kind: 'curtainRight10', name: 'Шторка справа 10%', desc: 'Чёрная шторка закрывает правый край на 10%' },
  { kind: 'curtainRight20', name: 'Шторка справа 20%', desc: 'Чёрная шторка закрывает правый край на 20%' },
  { kind: 'curtainRight50', name: 'Шторка справа 50%', desc: 'Чёрная шторка закрывает ПОЛОВИНУ справа' },
  { kind: 'pal50', name: '50 Гц (PAL)', desc: 'Игра замедляется как на европейских консолях: 60 → 50 Гц' },
  { kind: 'speed150', name: 'Ускорение ×1.5', desc: 'Игра ускоряется в полтора раза' },
  { kind: 'speed200', name: 'Ускорение ×2', desc: 'Игра ускоряется вдвое — реакция нужна молниеносная' },
  { kind: 'speed300', name: 'Ускорение ×3', desc: 'Игра ускоряется втрое — выживает не каждый' },
  { kind: 'lagButtons', name: 'Задержка кнопок', desc: 'Нажатия доходят до игры с запаздыванием ~0.4 секунды' },
];

/* Устаревшие пакости, которых больше нет в выборе, но они могут лежать в старых сохранениях */
const CHAOS_LEGACY: Partial<Record<ChaosKind, string>> = {
  blur: 'Туман (устарела)',
  scrollH1: 'Прокрутка → (удалена)',
  scrollH2: 'Прокрутка ← (удалена)',
  scrollV1: 'Прокрутка ↓ (удалена)',
  scrollV2: 'Прокрутка ↑ (удалена)',
};

export const chaosLabel = (k: ChaosKind): string =>
  CHAOS_LIST.find((x) => x.kind === k)?.name ?? CHAOS_LEGACY[k] ?? k;

export function mkChaosCard(k: ChaosKind): CardDef {
  const meta = CHAOS_LIST.find((x) => x.kind === k)!;
  return {
    id: 'chaos-' + k,
    kind: 'bonus',
    name: meta.name,
    desc: meta.desc,
    effect: { type: 'toInventory', value: 0, target: 0 },
    chaos: k,
  };
}

/* ---------- Радости: награды за прохождение заданий ---------- */

export type JoyId =
  | 'joy-diePlus' | 'joy-min5' | 'joy-min10' | 'joy-min30'
  | 'joy-immuneSega' | 'joy-immuneNes' | 'joy-joker';

export const JOY_LIST: { id: JoyId; name: string; desc: string }[] = [
  { id: 'joy-diePlus', name: '+1 кубик', desc: 'Следующий бросок — сразу ТРИ кубика. Нельзя применять при «Один кубик» и «Кубики-0»' },
  { id: 'joy-min5', name: '+5 мин и попыток', desc: 'Плюс 5 минут И плюс 5 попыток к вашим ресурсам' },
  { id: 'joy-min10', name: '+10 мин и попыток', desc: 'Плюс 10 минут И плюс 10 попыток к вашим ресурсам' },
  { id: 'joy-min30', name: '+30 мин и попыток', desc: 'Плюс 30 минут И плюс 30 попыток — джекпот радости' },
  { id: 'joy-immuneSega', name: 'Иммунитет к SEGA', desc: 'Встанете на задание с SEGA-ромом — можно пропустить его, не платя штраф. Сгорает при использовании' },
  { id: 'joy-immuneNes', name: 'Иммунитет к NES', desc: 'Встанете на задание с NES-ромом — можно пропустить его, не платя штраф. Сгорает при использовании' },
  { id: 'joy-joker', name: 'Джокер-пропуск', desc: 'Пропустить ЛЮБОЕ задание без платы. Сгорает при использовании' },
];

export function mkJoyCard(id: JoyId): CardDef {
  const m = JOY_LIST.find((x) => x.id === id)!;
  const eff: CardEffect =
    id === 'joy-diePlus' ? { type: 'diePlus', value: 1, target: 0 }
    : id === 'joy-min5' ? { type: 'addMinTries', value: 5, target: 0 }
    : id === 'joy-min10' ? { type: 'addMinTries', value: 10, target: 0 }
    : id === 'joy-min30' ? { type: 'addMinTries', value: 30, target: 0 }
    : id === 'joy-immuneSega' ? { type: 'immuneSega', value: 0, target: 0 }
    : id === 'joy-immuneNes' ? { type: 'immuneNes', value: 0, target: 0 }
    : { type: 'freeSkip', value: 0, target: 0 };
  return { id: m.id, kind: 'joy', name: m.name, desc: m.desc, effect: eff };
}

/* ---------- Торги карточками и ячейками ---------- */

export interface TradeOffer {
  id: string;
  from: string; // продавец (владелец карточки или ячейки)
  to: string; // покупатель
  cardId?: string; // торговля карточкой…
  cellIdx?: number; // …или ячейкой (смена хозяина, задание остаётся)
  priceMin: number; // цена в минутах
  priceTries: number; // цена в попытках
  status: 'pending' | 'countered' | 'declined' | 'done';
  counterMin?: number; // встречная цена покупателя
  counterTries?: number;
  ts: number;
}

export interface TileImg {
  id: string;
  name: string;
  dataUrl: string;
}

/* Группа-спойлер в палитре тайлов редактора: папка пользователя или нарезка экстрактором.
   Сами картинки лежат в map.tileset, группа — только упорядоченный список ссылок. */
export interface TileGroup {
  id: string;
  name: string;
  tids: string[];
  collapsed?: boolean;
  kind?: 'folder' | 'extract' | 'files' | 'edited'; // edited — «Изменённые»: тайлы, доработанные в пиксель-редакторе фишек
}

/* Штамп — экземпляр картинки из tileset, поставленный на поле.
   Позиция — ЦЕНТР в пикселях поля; w/h — размер в пикселях; rot — 0..3 по 90°;
   flip — зеркало по горизонтали (тайл, нарисованный только в одну сторону).
   ПОРЯДОК ОТРИСОВКИ: сначала слой (layer), внутри слоя — порядок в массиве
   (позже в массиве = выше). layer 0 — самый нижний тайловый слой. */
export interface Stamp {
  id: string;
  tid: string; // id картинки в map.tileset
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flip?: boolean;
  layer?: number; // номер тайлового слоя (0 — нижний); нет = 0. Фон — ниже всех, ячейки/стрелки — выше всех
}

/* Режим игры, задаваемый АВТОРОМ КАРТЫ в редакторе (левая панель):
   classic — обычная настолка с кубиками (как было);
   skill   — SKILL CHALLENGE: играет только хост, у него 25 ходов; остальные подключаются и смотрят;
   journey — JOURNEY: игроки ходят фишкой НАПРЯМУЮ (стрелки/WASD), наступили на ячейку — задание. */
export type MapMode = 'classic' | 'skill' | 'journey';
export const MAP_MODES: { id: MapMode; name: string; hint: string }[] = [
  { id: 'classic', name: 'CLASSIC', hint: 'Обычная игра с кубиками — ход по маршруту, ячейки, задания.' },
  { id: 'skill', name: 'SKILL CHALLENGE', hint: 'Играет только хост, лимит 25 ходов: остались ресурсы — челлендж пройден, нет — поражение. Остальные игроки подключаются как зрители.' },
  { id: 'journey', name: 'JOURNEY', hint: 'Приключение: игроки ходят фишкой напрямую в любые стороны, пересёк ячейку — сразу задание. Кубики и их бонусы/штрафы не действуют, побеждает последний с ресурсами.' },
];
export const SKILL_TURNS = 25; // лимит ходов хоста в SKILL CHALLENGE
export const JOURNEY_AUTO_PASS = 30; // JOURNEY: ход уходит следующему сам после стольких секунд без движения

export interface GameMap {
  id: string;
  name: string;
  cols: number;
  rows: number;
  mode?: MapMode; // режим игры; нет = classic (старые карты)
  tiles: PlacedTile[]; // СТАРЫЙ формат тайлов (глобальная библиотека) — новые карты не используют
  cells: CellDef[];
  bonusCards: CardDef[];
  trapCards: CardDef[];
  quizzes: QuizDef[]; // квизы карты (случайно выпадают на ячейках-квизах)
  startMin?: number; // стартовые минуты каждого игрока (по умолчанию 60)
  startTries?: number; // стартовые попытки каждого игрока (по умолчанию 60)
  /* --- редактор карт в стиле Tiled --- */
  mw?: number; // ширина поля в ПИКСЕЛЯХ (старые карты: cols * 64)
  mh?: number; // высота поля в пикселях (старые карты: rows * 64)
  bg?: string; // общий фон карты (dataUrl), рисуется под всем
  bgMode?: 'stretch' | 'real'; // растянуть на поле или рисовать 1:1 от левого верхнего угла
  tileset?: TileImg[]; // картинки тайлов, встроенные в КАРТУ (уезжают по P2P вместе с ней)
  tileGroups?: TileGroup[]; // спойлеры палитры: папки пользователя и нарезки экстрактора
  stamps?: Stamp[]; // размещённые тайлы (слой декора поверх фона, под ячейками)
  mapTokens?: TokenDef[]; // фишки партии (до 12): автор карты выбирает в редакторе, они вшиты в карту и уезжают всем игрокам; после жеребьёвки каждый игрок выбирает себе одну — одинаковые нельзя
  animLib?: AnimLibEntry[]; // анимации, вшитые в карту (из библиотеки анимаций автора)
  anims?: PlacedAnim[]; // размещённые анимации-декорации (рисуются поверх ВСЕХ тайловых слоёв, под ячейками)
  bossLib?: BossLibEntry[]; // боссы, вшитые в карту (из библиотеки боссов автора)
  bosses?: PlacedBoss[]; // размещённые боссы (реагируют на победы/поражения игроков в радиусе)
  tileLayers?: number; // количество тайловых слоёв (2..6); нет = 2. Фон — самый низ, ячейки и стрелки — самый верх; новые тайлы ставятся на выбранный слой левой панели
  smoothMove?: boolean; // плавное движение фишек без прыжков (для анимированных фишек); нет — прыжки по клеткам как раньше
  moveSpeed?: number; // скорость хода ВСЕХ фишек карты, клеток в секунду (0.5..6); нет — 1.2. Действует и на «плавно», и на «прыжками»
  ready: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TileDef {
  id: string;
  name: string;
  gw: number; // размер в клетках сетки по X
  gh: number;
  dataUrl: string;
  builtin?: boolean;
  folder?: string; // папка-набор; пустое = «Стандарт»
  createdAt: number;
}

export interface RomDef {
  id: string;
  name: string;
  fileName: string;
  ext: string;
  size: number;
  createdAt: number;
  folder?: string; // папка в левой панели «Запуска эмулятора» (спойлер); нет — ром без папки
}

export interface SaveDef {
  id: string;
  romId: string;
  slot: number;
  name: string;
  state: unknown; // JSON снапшот jsnes
  createdAt: number;
  kind?: SaveKind; // уровень / босс / моё задание / частное; нет = старое сохранение = уровень
}

export interface SessionSnapshot {
  id: string;
  name: string;
  mapName: string;
  code: string;
  state: GameSession;
  createdAt: number;
  auto?: boolean; // автосейв (перезаписываемый слот) или ручное сохранение
  slot?: number; // номер слота автосейва 0..4
}

/* ---------- runtime ---------- */

export interface PlayerState {
  id: string;
  name: string;
  color: number; // индекс палитры
  ready: boolean;
  isHost: boolean;
  secLeft: number;
  triesLeft: number;
  pos: number; // индекс в cells
  alive: boolean;
  skipTurns: number;
  extraTurn: boolean;
  spect?: boolean; // зритель (SKILL CHALLENGE): подключён, наблюдает за трансляцией, ходов не получает
  tokenImg?: string | null; // dataUrl своей фишки (PNG); null = стандартный робот
  tokenKey?: string; // id фишки из map.mapTokens, взятой игроком (уникальна на партию)
  tokenSize?: number; // размер фишки на поле в px (по большей стороне); нет — стандарт 34
  inventory?: CardDef[]; // карточки в инвентаре (пакости, радости и обычные «в инвентарь»)
  oneDie?: boolean; // пакость «Один кубик»: следующий бросок одним кубиком
  dicePlus?: boolean; // радость «+1 кубик»: следующий бросок тремя кубиками
  freeSkip?: boolean; // радость «Джокер»: пропуск задания без платы
  joyTurn?: number; // turnNo, когда радость уже применена (одна радость на ход)
}

export interface TokenDef {
  id: string;
  name: string;
  dataUrl: string; // PNG с поддержкой прозрачности (у анимированной — кадр idle, превью)
  builtin?: boolean;
  createdAt: number;
  anim?: TokenAnim; // анимированная фишка: клипы по направлениям + idle
  size?: number; // размер на поле в px по большей стороне; нет: анимированная = 64 (как тайл), обычная = 34 (как раньше)
}

/* ---------- Анимации (редактор анимаций и фишек) ---------- */

/* Один клип анимации: кадры по порядку + скорость (кадров в секунду).
   Кадры — dataUrl картинки из библиотеки тайлов редактора анимаций. */
export interface AnimClip {
  fps: number;       // кадров в секунду (1..24)
  frames: string[];  // dataUrl кадров по порядку проигрывания
}

/* Направление движения фишки — для выбора клипа анимации */
export type TokenDir = 'up' | 'down' | 'left' | 'right';

/* Анимированная фишка: idle обязателен (стоит на месте), направления — по наличии.
   Нет клипа направления — играет idle.
   win/lose — 5-я и 6-я анимации: победа над заданием и поражение, каждая со СВОИМ
   звуком; проигрываются ОДИН раз (победа — вместе с разбиванием ячейки, поражение —
   перед передачей хода). */
export interface TokenAnim {
  idle: AnimClip;
  up?: AnimClip;
  down?: AnimClip;
  left?: AnimClip;
  right?: AnimClip;
  win?: AnimClip;  // 5-й клип: победа над заданием (проигрывается один раз)
  lose?: AnimClip; // 6-й клип: поражение в задании (проигрывается один раз)
  snd?: string;     // data:audio — звук хода фишки: играет, ПОКА фишка идёт (вместо «щелчков» шагов); вшивается копией вместе с фишкой
  winSnd?: string;  // data:audio — отдельный звук победы над заданием
  loseSnd?: string; // data:audio — отдельный звук поражения
}

/* Звук из библиотеки редактора анимаций и фишек (IndexedDB).
   В анимации/фишку звук вшивается КОПИЕЙ (dataUrl), поэтому сам файл из библиотеки
   можно удалять — уже вшитые анимации не ломаются. Длинные записи делают карту тяжелее. */
export interface SoundDef {
  id: string;
  name: string;
  dataUrl: string; // data:audio/...
  size: number; // байт исходного файла
  createdAt: number;
  folder?: string; // папка-спойлер; нет — «Без папки»
}

/* Свободная анимация автора (библиотека в редакторе анимаций и фишек):
   её можно вшить в карту и размещать на поле как декорацию */
export interface AnimDef {
  id: string;
  name: string;
  clip: AnimClip;
  snd?: string; // data:audio — звук анимации (вшивается копией)
  createdAt: number;
}

/* Анимация, вшитая в КАРТУ (уезжает всем игрокам вместе с ней) */
export interface AnimLibEntry {
  id: string;
  name: string;
  clip: AnimClip;
  snd?: string; // звук, вшитый в карту вместе с анимацией
}

/* ---------- БОССЫ: анимация на ячейке, реагирующая на победы/поражения ----------
   Босс проигрывает idle (ждёт). Когда игрок в радиусе звука (r) ПОБЕЖДАЕТ или
   ПРОИГРЫВАЕТ задание — один раз проигрывается клип win/lose со своим звуком.
   Если игрок победил задание НА ЯЧЕЙКЕ БОССА и поставил СВОЁ — босс повержен:
   анимация останавливается на статичном кадре побеждённого босса (последний кадр win). */
export interface BossAnimDef {
  id: string;
  name: string;
  idle: AnimClip;   // обязательный клип — босс ждёт
  idleSnd?: string; // звук ожидания (играет по радиусу, как у обычных анимаций)
  win: AnimClip;    // босс получает удар игрока (победа игрока в задании)
  winSnd?: string;  // звук победы
  lose: AnimClip;   // босс бьёт игрока (поражение игрока)
  loseSnd?: string; // звук поражения
  createdAt: number;
}

/* Босс, вшитый в карту (уезжает всем игрокам) */
export interface BossLibEntry {
  id: string;
  name: string;
  idle: AnimClip;
  idleSnd?: string;
  win: AnimClip;
  winSnd?: string;
  lose: AnimClip;
  loseSnd?: string;
}

/* Размещённый на карте босс — как анимация: центр/размер в px поля + радиус
   срабатывания реакций и звука ожидания. Ставится на любую ячейку. */
export interface PlacedBoss {
  id: string;
  bid: string; // ссылка на BossLibEntry в map.bossLib
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number; // радиус: реакция босса и звук ждут игрока только ВНУТРИ круга; 0/нет — молчит и не реагирует
}

/* Размещённая на карте анимация — как штамп-тайл, но проигрывает кадры.
   Позиция — ЦЕНТР в пикселях поля; w/h — размер в пикселях. */
export interface PlacedAnim {
  id: string;
  aid: string; // ссылка на AnimLibEntry в map.animLib
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number; // радиус звука в px поля (у анимаций со звуком): фишка ИГРАЮЩЕГО вошла в круг — звук играет, только у него; в задании приглушается. нет/0 — молчит
}

/* ---------- Эффекты-спектакль (fx): разовые анимации на поле ----------
   tokenWin/tokenLose — 5-я/6-я анимация фишки (победа над заданием / поражение);
   bossWin/bossLose — реакция босса. gate=true блокирует ход до fxDone/истечения:
   после победы окно выбора откроется ТОЛЬКО после анимации, после поражения ход
   уйдёт следующему игроку только после анимации. after — что сделать по завершении. */
export interface GameFx {
  id: string;
  kind: 'tokenWin' | 'tokenLose' | 'bossWin' | 'bossLose';
  player: string; // чья фишка / кто спровоцировал
  cellIdx: number;
  bossId?: string; // для bossWin/bossLose
  ms: number;      // длительность, мс (считает хост по клипу)
  ts: number;      // Date.now() хоста в момент запуска
  gate?: boolean;
  after?: 'post' | 'endTurn' | 'none';
  delay?: number;  // пауза ДО старта клипа, мс: секунда тишины после задания, потом спектакль
}

export interface ChallengeState {
  cellIdx: number;
  mode: 'time' | 'tries' | null;
  started: boolean; // нажата ли «Запуск задания»
  paused: boolean;
  startedAt: number;
  accMs: number;
  loads: number;
  reloadId: number;
  status: 'choose' | 'ready' | 'playing' | 'voting';
  approvals: string[];
  violations: string[];
  lowStart: boolean; // при выборе ресурса его было меньше 5 — пропуск разрешён только на нуле
}

export interface GameSession {
  v: number;
  code: string;
  mapId: string;
  usedQuizzes: string[]; // уже прозвучавшие вопросы — в этой партии не повторяются
  phase: 'lobby' | 'rollOff' | 'playing' | 'over';
  players: PlayerState[];
  rollOffIdx: number;
  rollOffValues: Record<string, number>;
  rollOffReady?: string[]; // игроки, нажавшие «Я готов начать игру» после жеребьёвки
  rollOffWinner?: string | null; // победитель жеребьёвки — показывается всем перед стартом
  sealedRollOff?: { value: number; ts: number } | null; // «запечатанный» результат броска жеребьёвки
  turn: number;
  turnNo?: number; // номер хода партии (для именования автосейвов)
  dice: { a: number; b: number; c?: number; count?: number; zero?: boolean; roll: number } | null;
  /* «запечатанный» результат: хост предопределяет кубики в момент начала
     перемешивания, поэтому у бросающего они останавливаются без сетевой задержки */
  sealedDice?: { a: number; b: number; ts: number } | null;
  moving: { player: string; path: number[]; ts: number } | null;
  awaitPost: boolean;
  challenge: ChallengeState | null;
  pendingCard: { card: CardDef; player: string; done: boolean } | null;
  quiz: QuizRun | null;
  notice: { text: string; ts: number } | null; // временное уведомление на игровом экране
  captured: Record<number, string>;
  sessionTasks: Record<number, TaskDef>;
  trades: TradeOffer[]; // предложения обмена карточками (активные и последние закрытые)
  revealed: number[]; // индексы ячеек, на которые хоть раз ступали (для режима «скрытые ячейки»)
  journeyPos?: Record<string, { x: number; y: number; dir?: 'up' | 'down' | 'left' | 'right'; ts?: number }>; // JOURNEY: авторитетные позиции фишек в px поля (пишет хост)
  fxs?: GameFx[]; // разовые анимации-спектакль (последние несколько)
  /* Разбитые ячейки: победитель разбил ячейку победой над заданием. Пока ячейка
     разбита — она считается ПУСТОЙ (передышка), хозяин — победитель. Без нового
     задания восстанавливается сама через 2 хода любого игрока; победитель может
     поставить СВОЁ задание — оно вступит в силу через 3 хода (до тех пор ячейка
     так же разбита и пуста). Работает во всех режимах. at — момент разбития (Date.now()
     хоста; клиенты считают «осколки» от локального момента появления — рассинхрон часов не страшен). */
  broken?: Record<number, { by: string; left: number; task?: TaskDef; at?: number }>;
  moveSpeed?: number; // ЖИВАЯ скорость фишек, заданная хостом прямо во время партии (JOURNEY); нет — скорость карты
  bossDown?: Record<string, boolean>; // повержённые боссы (key — PlacedBoss.id): статичный кадр побеждённого
  winner: string | null;
  log: string[];
  startedAt: number;
}

export interface GameOptions {
  name: string;
  broadcast: boolean;
  autoReloadOnViolation: boolean;
  showCellNumbers: boolean;
  volume: number; // 0..1 — громкость эффектов интерфейса
  streamFps: number; // кадры в секунду трансляции экрана эмулятора
  emuSound: boolean; // УСТАРЕЛО — не используется (звук эмулятора теперь только ползунком у окна); поле оставлено для совместимости старых настроек
  emuVolume: number; // 0..1 — громкость звука эмуляторов
  hideUnrevealed: boolean; // скрывать непосещённые ячейки (иконки бонусов/ловушек и картинки заданий)
  relay: string; // свой сигнальный сервер «IP:порт» (пусто = облако 0.peerjs.com)
  relayHub: string; // игровой хаб (WebSocket): весь трафик через сервер; приоритетнее PeerJS
  turn: string; // TURN для жёсткого NAT: «user:pass@host:port», несколько — через запятую (пусто = только STUN)
  delMode: 'instant' | 'confirm' | 'hold'; // защита от случайного удаления в редакторах: сразу / с окошком / долгим нажатием
}

export interface NetMsg {
  mid: string;
  from: string;
  t: string;
  p?: unknown;
}

export const APP_VERSION = 24; // 24: 5-я анимация фишки «победа над заданием» (с отдельным звуком) — ячейка РАЗБИВАЕТСЯ, окно выбора открывается после анимации; без нового задания ячейка восстанавливается через 2 хода, с заданием игрока — через 3; 6-я анимация «поражение» (со звуком) — после неё ход уходит дальше; боссы-анимации на ячейках (idle + реакции на победу/поражение в радиусе, статичный кадр побеждённого); JOURNEY: движение фишкой стрелками ДЖОЙСТИКА (геймпад), кнопка «Передать ход» убрана — ход уходит сам после 30 с без движения; SKILL CHALLENGE: «создать задание» недоступно — играешь один, сражаешься только с собой
export const START_SEC = 60 * 60;
export const START_TRIES = 60;
export const SKIP_COST = 5;
export const PLAYER_COLORS = ['#ff5d5d', '#5aa9ff', '#35d46f', '#ffcf3f'];
export const PLAYER_NAMES = ['КРАСНЫЙ', 'СИНИЙ', 'ЗЕЛЁНЫЙ', 'ЖЁЛТЫЙ'];
