export type CellType = 'start' | 'task' | 'rest' | 'bonus' | 'trap' | 'quiz' | 'loot'; // rest — пустая клетка-передышка: ничего не происходит, ром не нужен; loot — ЛУТБОКС (только RUBG): разовый подбор случайного предмета

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

/* НЕВИДИМЫЕ СТЕНЫ (для JOURNEY): прямоугольные зоны поля, куда фишка НЕ МОЖЕТ зайти.
   Ходить изначально можно везде — стены только исключения. Работают ТОЛЬКО в
   режиме journey (в других режимах редактор карт не даст сохранить карту со стенами).
   В игре стены НЕ рисуются (невидимые); в редакторе — штрихуются коралловым. */
export interface WallRect {
  x: number; // левый край, px поля
  y: number; // верхний край, px поля
  w: number; // ширина, px
  h: number; // высота, px
}

/* ПОРТАЛЫ: зоны-телепорты для БОЛЬШИХ КАРТ. Фишка (JOURNEY, свободное хождение),
   ВОШЕДШИ в зону портала, мгновенно переносится в точку перехода (tx,ty) — обычно
   на другой ПЛИТКЕ карты. Координаты — px ВСЕГО поля. Портал однонаправленный:
   чтобы вернуться, автор ставит второй портал. В CLASSIC/SKILL фишки ходят по
   маршруту — там плитки связывают стрелки-переходы (прыжок ячейка → ячейка). */
export interface PortalZone {
  id: string;
  x: number; // левый край зоны входа, px поля
  y: number; // верхний край зоны входа, px поля
  w: number; // ширина зоны, px
  h: number; // высота зоны, px
  tx?: number; // точка перехода X (центр фишки после переноса), px поля; нет — портал ещё не настроен
  ty?: number; // точка перехода Y, px поля
}

/* ПЛИТКИ КАРТЫ: GameMap.plateSize = сторона одной плитки (1024/2048/4096 px).
   Поле (mw×mh) делится на страницы-плитки этого размера. Соседние плитки
   стыкуются краями — фишка переходит между ними ХОДЬБОЙ в любом месте стыка
   (поле единое, стены по-прежнему вырезают запретные зоны). Любые плитки
   связываются ПОРТАЛАМИ. Разбивка — удобство редактора: навигатор плиток в
   левой панели; в игре это одно большое поле. */
export type PlateSize = 1024 | 2048 | 4096;
export const PLATE_SIZES: PlateSize[] = [1024, 2048, 4096];
export const MAX_FIELD = 16384; // предельный размер поля по каждой стороне, px

/* ПЛИТОЧНЫЙ РЕЖИМ КАРТ (GameMap.tileGrid): карта состоит из НЕСКОЛЬКИХ ОТДЕЛЬНЫХ
   карт-плиток ОДИНАКОВОГО заданного размера (w×h). Каждая карта-плитка — своя
   «локация»: в редакторе она показывается СХЕМАТИЧНО в спойлере «Карты-плитки»
   левой панели (клик — перейти на эту карту), новые добавляются кнопкой.
   В ИГРЕ фишка ЗАКРЕПЛЕНА за своей картой-плиткой: выйти за её край нельзя,
   на ДРУГУЮ карту попадают ТОЛЬКО через ПОРТАЛ (соседняя она или нет — неважно).
   Бесконечное увеличение поля (без tileGrid) продолжает работать как раньше. */
export interface MapTileInfo {
  id: string;
  col: number; // столбец в схеме плиток (0..)
  row: number; // строка в схеме плиток (0..)
}
export interface TileGrid {
  w: number; // ширина КАЖДОЙ карты-плитки, px
  h: number; // высота КАЖДОЙ карты-плитки, px
  tiles: MapTileInfo[]; // какие клетки схемы заняты картами-плитками
}
/** Прямоугольник карты-плитки в px поля. */
export const tileRectOf = (g: TileGrid, t: MapTileInfo) => ({ x: t.col * g.w, y: t.row * g.h, w: g.w, h: g.h });
/** Карта-плитка, содержащая точку поля (px); нет такой — null. */
export const tileAt = (g: TileGrid, x: number, y: number): MapTileInfo | null => {
  const col = Math.floor(x / g.w), row = Math.floor(y / g.h);
  return g.tiles.find((t) => t.col === col && t.row === row) ?? null;
};
/** Номер карты-плитки для людей (с 1, по порядку в списке). */
export const tileNumOf = (g: TileGrid, id: string): number => g.tiles.findIndex((t) => t.id === id) + 1;

/* Режим игры, задаваемый АВТОРОМ КАРТЫ в редакторе (левая панель):
   classic   — RETROPOLIA: обычная настолка с кубиками (как было);
   skill     — SKILL CHALLENGE: играет только хост, у него 25 ходов; остальные подключаются и смотрят;
   journey   — TRIATHLON: все фишки ходят ОДНОВРЕМЕННО (стрелки/WASD), кто первый пересёк
               ячейку задания — у того открывается задание, остальные смотрят трансляцию;
   journey1p — JOURNEY: одиночное приключение — механика TRIATHLON, но играет только хост,
               все подключившиеся — зрители.
   Внутренние id НЕ менялись (старые карты и сохранения совместимы) — сменились
   только отображаемые имена: CLASSIC → RETROPOLIA, JOURNEY → TRIATHLON. */
export type MapMode = 'classic' | 'skill' | 'journey' | 'journey1p' | 'rubg';
export const MAP_MODES: { id: MapMode; name: string; hint: string }[] = [
  { id: 'classic', name: 'RETROPOLIA', hint: 'Обычная игра с кубиками — ход по маршруту, ячейки, задания.' },
  { id: 'skill', name: 'SKILL CHALLENGE', hint: 'Играет только хост, лимит 25 ходов: остались ресурсы — челлендж пройден, нет — поражение. Каждый ход — задание: ячейки квизов, бонусов, штрафов и отдыха запрещены. Остальные игроки подключаются как зрители.' },
  { id: 'journey', name: 'TRIATHLON', hint: 'Приключение на ВСЕХ: все фишки стартуют одновременно и ходят напрямую в любые стороны, кубиков и передачи хода нет. Кто ПЕРВЫМ пересечёт ячейку задания — у того оно открывается, остальные фишки замирают и смотрят трансляцию. Побеждает последний с ресурсами.' },
  { id: 'journey1p', name: 'JOURNEY', hint: 'Одиночное приключение: механика TRIATHLON (свободное хождение без кубиков), но играет ТОЛЬКО ХОСТ — все подключившиеся игроки становятся зрителями трансляции.' },
  { id: 'rubg', name: 'RUBG', hint: 'Retro Ultimate Battle Ground — «ретро-PUBG»: все летят на самолёте и прыгают где хотят; задания играются ЛИЧНО, без остановки других и без подтверждений (доверие); ресурс один — полоска HP; безопасная зона сжимается и жжёт вне себя; лутбоксы, стелс, атаки и кражи. Побеждает последний живой.' },
];
/** Свободное хождение (механика JOURNEY) — TRIATHLON, одиночный JOURNEY и RUBG. */
export const isJourneyLike = (m: MapMode | undefined): boolean => m === 'journey' || m === 'journey1p' || m === 'rubg';
/** Одиночные режимы: играет только хост, остальные — зрители (можно стартовать одному). */
export const isSoloMode = (m: MapMode | undefined): boolean => m === 'skill' || m === 'journey1p';
export const SKILL_TURNS = 25; // лимит ходов хоста в SKILL CHALLENGE

/* ---------- СВОИ ЧЕЛЛЕНДЖИ (мастер «СОЗДАТЬ ЧЕЛЛЕНДЖ» на главном экране) ----------
   Автор отвечает на серию вопросов — из ответов складываются ПРАВИЛА челленджа:
   готовый набор настроек появляется в редакторе карт в панели «Режим игры»
   с пометкой «СВОЙ РЕЖИМ» и применяется к карте одним кликом. */
export interface ChallengeAnswers {
  players: 'solo' | 'together' | 'turns'; // одному (зрители) / всем одновременно / по очереди с кубиками
  platform: 'phone' | 'pc' | 'both';      // на чём играют (подсказка для автора)
  field: 's' | 'm' | 'l' | 'tiles';       // какая карта: малая / средняя / большая / плиточный режим
  cells: CellType[];                      // какие ячейки можно использовать
  cellAmount: 'few' | 'mid' | 'many';     // сколько ячеек ориентировочно
  resTime: boolean;                       // использовать время
  resTries: boolean;                      // использовать попытки
  resCoins: boolean;                      // использовать МОНЕТЫ (третий ресурс)
  startMin: number;                       // стартовых минут
  startTries: number;                     // стартовых попыток
  startCoins: number;                     // стартовый капитал, бронзовых единиц (100 = 1 серебряная)
  coinsOnly: boolean;                     // ТОЛЬКО монеты: задания не тратят время/попытки, 0 монет = поражение
  taskWinCoins: number;                   // награда за ПОБЕДУ в задании, бронзы
  skipCoins: number;                      // цена ПРОПУСКА/проигрыша задания, бронзы (0 = бесплатно)
  quizWinCoins: number;                   // награда за ВЕРНЫЙ ответ в квизе, бронзы
  quizLoseCoins: number;                  // штраф за НЕВЕРНЫЙ ответ в квизе, бронзы
  penalties: boolean;                     // нужны ли штрафы за проигрыш задания (время/попытки)
  loseMin: number;                        // ... отнимать минут за проигрыш
  loseTries: number;                      // ... отнимать попыток за проигрыш
  winMin: number;                         // ... возвращать минут за победу (награда)
  winTries: number;                       // ... возвращать попыток за победу
  speed: number;                          // скорость фишек, клеток/с
  /* --- БЕЗКАРТОВЫЙ ЧЕЛЛЕНДЖ: играем без создания карты — только матчи-игры --- */
  mapless?: boolean;                      // без карты: игрок просто играет в игры по очереди (без фишек и соперников)
  maplessRandom?: boolean;                // игры выбирает РАНДОМАЙЗЕР (колесо фортуны); false — игры играются по списку
  maplessRomIds?: string[];               // список игр (по порядку) для режима «по списку»
  maplessFolder?: string;                 // папка ромов для рандомайзера ('' — все ромы)
  maplessCount?: number;                  // сколько случайных игр до победы (для рандомайзера)
}
export interface ResolvedChallenge {
  baseMode: MapMode;      // выбранный режим игры
  mw: number; mh: number; // размер поля
  tileMode: boolean;      // включить плиточный режим
  startMin: number;
  startTries: number;
  resCoins: boolean;      // монеты включены (иначе монетные поля игнорируются)
  startCoins: number;     // стартовый капитал, бронзы
  coinsOnly: boolean;     // только монеты
  taskWinCoins: number;
  skipCoins: number;
  quizWinCoins: number;
  quizLoseCoins: number;
  loseMin: number;
  loseTries: number;
  winMin: number;
  winTries: number;
  speed: number;
  /* безкартовый челлендж */
  mapless: boolean;
  maplessRandom: boolean;
  maplessRomIds: string[];
  maplessFolder: string;
  maplessCount: number;
}
export interface CustomChallenge {
  id: string;
  name: string;
  answers: ChallengeAnswers;
  resolved: ResolvedChallenge;
  createdAt: number;
  updatedAt: number;
}
/** Читаемые ответы мастера — для сводки в окне создания и описания режима. */
export const challengeSummaryLines = (a: ChallengeAnswers): string[] => {
  if (a.mapless) {
    const games = a.maplessRandom
      ? `рандомайзер из папки «${a.maplessFolder || 'все ромы'}» — ${a.maplessCount ?? 25} игр`
      : `по списку — ${a.maplessRomIds?.length ?? 0} игр`;
    const res = [a.resTime ? 'время' : '', a.resTries ? 'попытки' : '', a.resCoins ? `монеты (старт ${coinsStr(a.startCoins)})` : ''].filter(Boolean).join(' + ') || 'без ресурсов';
    return [`БЕЗ КАРТЫ: ${games}`, `Ресурсы: ${res}`, a.resCoins ? `задание: +${a.taskWinCoins} бронзы за победу, пропуск ${a.skipCoins} бронзы` : 'без монетной экономики'];
  }
  const players = a.players === 'solo' ? 'Играет один, остальные — зрители' : a.players === 'together' ? 'Все играют одновременно' : 'Играют по очереди (кубики)';
  const field = a.field === 's' ? 'Малая карта' : a.field === 'm' ? 'Средняя карта' : a.field === 'l' ? 'Большая карта' : 'Плиточный режим (несколько карт-локаций)';
  const amount = a.cellAmount === 'few' ? 'немного ячеек (10–20)' : a.cellAmount === 'mid' ? 'средне ячеек (20–40)' : 'много ячеек (40+)';
  const res = [a.resTime ? 'время' : '', a.resTries ? 'попытки' : '', a.resCoins ? `монеты (старт ${coinsStr(a.startCoins)})` : ''].filter(Boolean).join(' + ') || 'без ресурсов';
  const pen = a.penalties ? `штрафы за проигрыш: −${a.loseMin} мин / −${a.loseTries} поп.; награда за победу: +${a.winMin} мин / +${a.winTries} поп.` : 'без штрафов и наград (время/попытки)';
  const coinEco = a.resCoins ? `монеты: +${a.taskWinCoins} бронзы за победу в задании, пропуск ${a.skipCoins} бронзы, квиз +${a.quizWinCoins}/−${a.quizLoseCoins} бронзы` : '';
  return [players, field, `Ячейки: ${amount}`, `Ресурс: ${res} (старт ${a.startMin} мин / ${a.startTries} поп.)`, pen, coinEco, `Скорость фишек: ${a.speed} кл/с`].filter(Boolean);
};

export interface PlateBg {
  bg: string; // dataUrl картинки фона ПЛИТКИ
  bgMode?: 'stretch' | 'real'; // растянуть на плитку или рисовать 1:1 от левого верхнего угла плитки
}

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
  plateBgs?: { [plateNum: number]: PlateBg }; // свои фоны ПЛИТОК: ключ — номер плитки (как в навигаторе, с 1); каждая плитка = своя «локация»; рисуется ПОВЕРХ общего фона в пределах своей плитки
  tileset?: TileImg[]; // картинки тайлов, встроенные в КАРТУ (уезжают по P2P вместе с ней)
  tileGroups?: TileGroup[]; // спойлеры палитры: папки пользователя и нарезки экстрактора
  stamps?: Stamp[]; // размещённые тайлы (слой декора поверх фона, под ячейками)
  mapTokens?: TokenDef[]; // фишки партии (до 12): автор карты выбирает в редакторе, они вшиты в карту и уезжают всем игрокам; после жеребьёвки каждый игрок выбирает себе одну — одинаковые нельзя
  animLib?: AnimLibEntry[]; // анимации, вшитые в карту (из библиотеки анимаций автора)
  anims?: PlacedAnim[]; // размещённые анимации-декорации (рисуются поверх ВСЕХ тайловых слоёв, под ячейками)
  bossLib?: BossLibEntry[]; // боссы, вшитые в карту (из библиотеки боссов автора)
  bosses?: PlacedBoss[]; // размещённые боссы (реагируют на победы/поражения игроков в радиусе)
  walls?: WallRect[]; // НЕВИДИМЫЕ СТЕНЫ: зоны, куда фишке нельзя (только JOURNEY); в игре не рисуются
  portals?: PortalZone[]; // ПОРТАЛЫ: зоны-телепорты между любыми точками поля (плитками); вход фишки = мгновенный перенос (JOURNEY); в игре видны мягким сиреневым свечением
  plateSize?: number; // сторона ПЛИТКИ (1024/2048/4096): поле делится на страницы-плитки; соседние стыкуются краями, любые связываются порталами; нет — карта без разбивки
  tileGrid?: TileGrid; // ПЛИТОЧНЫЙ РЕЖИМ КАРТ: карта из нескольких отдельных карт-плиток одинакового размера; нет — обычное (бесконечно растущее) поле
  tileBgs?: { [tileId: string]: PlateBg }; // свои фоны КАРТ-ПЛИТОК в плиточном режиме: ключ — id карты-плитки, у каждой своя «локация»
  customId?: string; // свой челлендж (мастер «Создать челлендж»), применённый к карте
  customName?: string; // имя своего челленджа — показывается в редакторе и при выборе карты
  startCoins?: number; // МОНЕТЫ: стартовый капитал каждого игрока, бронзовых единиц (100 = 1 серебряная); нет — монеты не используются
  coinsOnly?: boolean; // ТОЛЬКО монеты: задания не тратят время/попытки (их выбор не предлагается), 0 монет = вылет
  taskWinCoins?: number; // награда: +бронзы за ПОБЕДУ в задании (монеты активны)
  skipCoins?: number; // цена пропуска/проигрыша задания, бронзы (0 = бесплатно; нет — 5)
  quizWinCoins?: number; // награда: +бронзы за ВЕРНЫЙ ответ в квизе (монеты активны)
  quizLoseCoins?: number; // штраф: −бронзы за НЕВЕРНЫЙ ответ в квизе (монеты активны)
  loseMin?: number; // штраф челленджа: минут за проигрыш задания (0/нет — как раньше)
  loseTries?: number; // штраф челленджа: попыток за проигрыш задания
  winMin?: number; // награда челленджа: минут за победу в задании
  winTries?: number; // награда челленджа: попыток за победу в задании
  tileLayers?: number; // количество тайловых слоёв (2..6); нет = 2. Фон — самый низ, ячейки и стрелки — самый верх; новые тайлы ставятся на выбранный слой левой панели
  smoothMove?: boolean; // плавное движение фишек без прыжков (для анимированных фишек); нет — прыжки по клеткам как раньше
  moveSpeed?: number; // скорость хода ВСЕХ фишек карты, клеток в секунду (0.5..6); нет — 1.2. Действует и на «плавно», и на «прыжками»
  mapless?: MaplessCfg; // БЕЗКАРТОВАЯ ИГРА (челлендж без карты): экран карты не показывается — только матчи-игры; для SKILL CHALLENGE поле не нужно — он всегда без карты
  ready: boolean;
  createdAt: number;
  updatedAt: number;
}

/* БЕЗКАРТОВАЯ ИГРА: конфиг из челленджа, вшитый в сгенерированную карту.
   Экран игры вместо поля показывает список матчей/рандомайзер. */
export interface MaplessCfg {
  total: number; // всего матчей до победы
  random: boolean; // игры выбирает рандомайзер (колесо фортуны); false — по списку
  pool?: { romId: string; title: string }[]; // пул для рандомайзера (вшит из челленджа — виден всем без библиотеки)
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
  coinsLeft?: number; // МОНЕТЫ: капитал в бронзовых единицах (1 серебряная = 100); нет/0 — монет нет
  hp?: number; // RUBG: полоска здоровья 0..100 (проценты) — ЕДИНСТВЕННЫЙ ресурс режима
  items?: RubgItem[]; // RUBG: инвентарь (хилки, оружие, карты воровства и стелса)
  stealth?: boolean; // RUBG: игрок в стелсе — другие его фишку НЕ видят
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
   ОДИН раз играется клип defeated (со своим звуком, если задан), потом босс
   навсегда замирает на его последнем кадре. */
export interface BossAnimDef {
  id: string;
  name: string;
  idle: AnimClip;   // обязательный клип — босс ждёт
  idleSnd?: string; // звук ожидания (играет по радиусу, как у обычных анимаций)
  win: AnimClip;    // босс получает удар игрока (победа игрока в задании)
  winSnd?: string;  // звук победы
  lose: AnimClip;   // босс бьёт игрока (поражение игрока)
  loseSnd?: string; // звук поражения
  defeated?: AnimClip; // клип ПОРАЖЕНИЯ БОССА: играется один раз, когда игрок победил его ячейку и поставил своё; нет — босс замирает на последнем кадре win (как раньше)
  defSnd?: string;     // звук гибели босса (к клипу defeated)
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
  defeated?: AnimClip; // клип гибели босса (как у BossAnimDef)
  defSnd?: string;     // звук гибели босса
}

/* Снимок босса для вшивания в карту: все клипы и звуки библиотечного босса,
   включая необязательный клип гибели. Общий для MapEditor (вшивание),
   TokenEditor (обновление вшитых копий) и Lobby (подтяжка снимков при старте). */
export const bossLibEntryOf = (b: BossAnimDef): BossLibEntry => ({
  id: b.id,
  name: b.name,
  idle: JSON.parse(JSON.stringify(b.idle)),
  ...(b.idleSnd ? { idleSnd: b.idleSnd } : {}),
  win: JSON.parse(JSON.stringify(b.win)),
  ...(b.winSnd ? { winSnd: b.winSnd } : {}),
  lose: JSON.parse(JSON.stringify(b.lose)),
  ...(b.loseSnd ? { loseSnd: b.loseSnd } : {}),
  ...(b.defeated ? { defeated: JSON.parse(JSON.stringify(b.defeated)) } : {}),
  ...(b.defSnd ? { defSnd: b.defSnd } : {}),
});

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
   bossWin/bossLose — реакция босса; bossDef — гибель босса (игрок победил его ячейку
   и поставил своё). gate=true блокирует ход до fxDone/истечения:
   после победы окно выбора откроется ТОЛЬКО после анимации, после поражения ход
   уйдёт следующему игроку только после анимации. after — что сделать по завершении. */
export interface GameFx {
  id: string;
  kind: 'tokenWin' | 'tokenLose' | 'bossWin' | 'bossLose' | 'bossDef';
  player: string; // чья фишка / кто спровоцировал
  cellIdx: number;
  bossId?: string; // для bossWin/bossLose
  ms: number;      // длительность, мс (считает хост по клипу)
  ts: number;      // Date.now() хоста в момент запуска
  gate?: boolean;
  after?: 'post' | 'endTurn' | 'none';
  delay?: number;  // пауза ДО старта клипа, мс: секунда тишины после задания, потом спектакль
}

/* ---------- RUBG (Retro Ultimate Battle Ground) — «ретро-PUBG» ----------
   Все играют ОДНОВРЕМЕННО: самолёт летит через карту, каждый выпрыгивает где хочет.
   Задания играются ЛИЧНО (не останавливают других, без трансляции и подтверждений).
   Ресурс один — полоска HP; безопасная зона сжимается, вне неё HP тает.
   Вместо бонусов/штрафов — лутбоксы: хилки, оружие, карты воровства и стелса. */
export type RubgItemKind = 'flask' | 'medkit' | 'bigmed' | 'pistol' | 'smg' | 'sniper' | 'steal' | 'stealth';
export interface RubgItem {
  id: string;
  kind: RubgItemKind;
  uses?: number; // карта воровства: 3 использования
}
export const RUBG_ITEMS: Record<RubgItemKind, { name: string; hp: number; radius: number; loot: number; icon: string }> = {
  // hp — урон/лечение в ПРОЦЕНТАХ полоски; radius — радиус атаки в клетках (0 — не оружие); loot — вес в лут-таблице
  flask:    { name: 'Фляжка',            hp: 10,  radius: 0,  loot: 26, icon: '🥃' },
  medkit:   { name: 'Аптечка',           hp: 25,  radius: 0,  loot: 18, icon: '🧰' },
  bigmed:   { name: 'Ящик медбрата',     hp: 75,  radius: 0,  loot: 7,  icon: '📦' },
  pistol:   { name: 'Пистолет',          hp: 5,   radius: 3,  loot: 16, icon: '🔫' },
  smg:      { name: 'Пистолет-пулемёт',  hp: 15,  radius: 6,  loot: 11, icon: '💥' },
  sniper:   { name: 'Снайперка',         hp: 40,  radius: 12, loot: 5,  icon: '🎯' },
  steal:    { name: 'Карта воровства',   hp: 0,   radius: 0,  loot: 12, icon: '🤏' }, // 3 использования
  stealth:  { name: 'Карта стелса',      hp: 0,   radius: 0,  loot: 5,  icon: '👻' },
};
export const STEAL_USES = 3; // использования карты воровства
export const rubgMkItem = (kind: RubgItemKind): RubgItem => ({
  id: 'it' + Math.random().toString(36).slice(2, 9), kind,
  ...(kind === 'steal' ? { uses: STEAL_USES } : {}),
});
/** Случайный предмет по весам лут-таблицы. */
export const rubgRandomKind = (): RubgItemKind => {
  const entries = Object.entries(RUBG_ITEMS) as [RubgItemKind, { loot: number }][];
  const total = entries.reduce((a, [, v]) => a + v.loot, 0);
  let roll = Math.random() * total;
  for (const [kind, v] of entries) { roll -= v.loot; if (roll <= 0) return kind; }
  return 'flask';
};
export const RUBG_HP_MAX = 100;      // полоска HP — проценты
export const RUBG_WIN_HP = 10;       // +HP за победу в задании + случайный предмет
export const RUBG_LOSE_HP = 5;       // −HP за проигрыш задания
export const RUBG_STEAL_RANGE = 1.6; // дистанция кражи/атаки вплотную, клеток
export const RUBG_STOP_CD = 15;      // кулдаун кнопки «Остановить вора», секунд
export interface RubgZone {
  cx: number; cy: number; r: number;        // ТЕКУЩИЙ круг (px поля) — пересчитывается хостом каждый тик
  sx: number; sy: number; sr: number;       // ОТКУДА сжимаемся (начало текущей фазы сжатия)
  tx: number; ty: number; tr: number;       // цель сжатия (куда сожмётся)
  phase: 'wait' | 'shrink';                 // ждём или сжимаемся
  phaseStart: number; phaseEnd: number;     // границы фазы, Date.now() хоста (клиенты рисуют интерполяцией)
  idx: number;                              // номер фазы (0..RUBG_ZONE_PHASES.length-1)
  dps: number;                              // урон ВНЕ зоны в секунду (% HP)
  lastTick: number;                         // момент прошлого подсчёта урона
}
export interface RubgJob {
  cellIdx: number;       // ячейка задания
  startedAt: number;     // когда игрок вошёл
}
export interface RubgSteal {
  thief: string; victim: string;
  dur: number;           // сколько секунд есть у вора (чем дольше держал кнопку — тем больше)
  startedAt: number;
}
export interface RubgPlane {
  x0: number; y0: number; x1: number; y1: number; // отрезок полёта через карту
  startAt: number;       // Date.now() хоста в момент старта полёта
  speed: number;         // px в секунду
  jumped: string[];      // кто уже выпрыгнул
}
export interface RubgState {
  plane?: RubgPlane;                       // фаза полёта (rollOff): все прыгнули → playing
  zone: RubgZone | null;                   // безопасная зона (появляется при старте партии)
  jobs?: Record<string, RubgJob>;          // ЛИЧНЫЕ задания: key — id игрока
  looted?: number[];                       // индексы ВСКРЫТЫХ лутбоксов (одноразовые)
  stealth?: string[];                      // кто в стелсе сейчас
  steals?: Record<string, RubgSteal>;      // активные кражи: key — id ЖЕРТВЫ
  stopCd?: Record<string, number>;         // кулдаун «Остановить вора»: key — игрок, значение — ts последнего нажатия
}
export const RUBG_ZONE_PHASES: { wait: number; shrink: number; mul: number; dps: number }[] = [
  { wait: 40, shrink: 30, mul: 0.65, dps: 1 },
  { wait: 30, shrink: 25, mul: 0.6,  dps: 2 },
  { wait: 25, shrink: 20, mul: 0.55, dps: 4 },
  { wait: 20, shrink: 15, mul: 0.5,  dps: 8 },
  { wait: 15, shrink: 15, mul: 0.45, dps: 12 },
  { wait: 10, shrink: 20, mul: 0,    dps: 20 }, // финал: карта вся в запретной зоне
];
/** Позиция фишки в px поля (для RUBG-логики: расстояния, зона). */
export const playerPx = (s: GameSession, map: GameMap, id: string): { x: number; y: number } | null => {
  const jp = s.journeyPos?.[id];
  if (jp) return { x: jp.x, y: jp.y };
  const p = s.players.find((x) => x.id === id);
  if (!p) return null;
  const c = map.cells[p.pos];
  return c ? { x: c.cx ?? (c.x + (c.w || 1) / 2) * 64, y: c.cy ?? (c.y + (c.h || 1) / 2) * 64 } : null;
};

export interface ChallengeState {
  cellIdx: number;
  mode: 'time' | 'tries' | 'coins' | null;
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
  journeyPos?: Record<string, { x: number; y: number; dir?: 'up' | 'down' | 'left' | 'right'; ts?: number; mv?: boolean; tp?: boolean }>; // JOURNEY: авторитетные позиции ВСЕХ фишек в px поля (пишет хост); mv — «идёт сейчас» (false = стоит); tp — это обновление несёт ПРЫЖОК ЧЕРЕЗ ПОРТАЛ (принимать без анти-телепорта, у зрителей — мгновенный снап)
  skillDone?: number[]; // SKILL CHALLENGE / БЕЗКАРТОВАЯ ИГРА: ячейки, которые хост уже ПРОШЁЛ или ПРОПУСТИЛ — встав на них снова, фишка сама едет к следующей неигранной
  mapless?: { done: number; total: number; over: boolean }; // БЕЗКАРТОВАЯ ИГРА (СТАРЫЕ карты v0.36.0): сколько матчей сыграно, сколько всего, флаг «все матчи сыграны — пора завершать победой» (завершает хост действием maplessFinish после анимаций)
  rubg?: RubgState; // RUBG: самолёт, зона, личные задания, кражи, стелс
  fxs?: GameFx[]; // разовые анимации-спектакль (последние несколько)
  /* Разбитые ячейки: победитель разбил ячейку победой над заданием. Пока ячейка
     разбита — она считается ПУСТОЙ (передышка), хозяин — победитель. Без нового
     задания восстанавливается сама через 2 хода любого игрока; победитель может
     поставить СВОЁ задание — оно вступит в силу через 3 хода (до тех пор ячейка
     так же разбита и пуста). Работает во всех режимах. at — момент разбития (Date.now()
     хоста; клиенты считают «осколки» от локального момента появления — рассинхрон часов не страшен). */
  broken?: Record<number, { by: string; left: number; task?: TaskDef; at?: number }>;
  bossDown?: Record<string, boolean>; // повержённые боссы (key — PlacedBoss.id): замирают на последнем кадре клипа defeated (или win у старых)
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
  hideRoomCode: boolean; // скрывать код комнаты: большой код в лобби и код в шапке во время игры показываются как «••••»
}

export interface NetMsg {
  mid: string;
  from: string;
  t: string;
  p?: unknown;
}

export const APP_VERSION = 30; // 30: RUBG — «ретро-PUBG»: самолёт и прыжки, ЛИЧНЫЕ задания без остановки других (доверие, без подтверждений), полоска HP как ЕДИНСТВЕННЫЙ ресурс, сжимающаяся безопасная зона с уроном, лутбоксы (хилки/оружие/карты воровства и стелса), кража из кармана, стелс, атаки; ресурс теперь ТОЛЬКО ОДИН (попытки ИЛИ время ИЛИ монеты); удаление своих челленджей; вопрос «на чём играют» из мастера убран; безкартовые челленджи убраны — SKILL CHALLENGE снова играется НА КАРТЕ
export const START_SEC = 60 * 60;
export const START_TRIES = 60;
export const SKIP_COST = 5;

/* ---------- МОНЕТЫ: третий ресурс (мастер «Создать челлендж» и редактор карт) ----------
   Единое хранилище — БРОНЗОВЫЕ единицы. Курс: 1 платиновая = 100 золотых =
   10 000 серебряных = 1 000 000 бронзовых. Капитал игрока отображается всеми
   ступенями сразу (например «2 плат. 3 зол. 42 серебр. 5 бронзы»). Кап — 99 платиновых. */
export const COINS_MAX = 99 * 100 * 100 * 100; // 99 платиновых в бронзе
export const SKIP_COINS_DEFAULT = 5; // цена пропуска монетами по умолчанию (5 бронзы)
/** Разложить бронзовые единицы на ступени (платина/золото/серебро/бронза). */
export const coinsSplit = (v: number): { pl: number; go: number; si: number; br: number } => {
  const b = Math.max(0, Math.floor(v));
  return { br: b % 100, si: Math.floor(b / 100) % 100, go: Math.floor(b / 10000) % 100, pl: Math.floor(b / 1000000) };
};
/** Полная строка капитала: только ненулевые ступени («1 серебр. 50 бронзы»). */
export const coinsStr = (v: number): string => {
  const { pl, go, si, br } = coinsSplit(v);
  const parts: string[] = [];
  if (pl) parts.push(`${pl} плат.`);
  if (go) parts.push(`${go} зол.`);
  if (si) parts.push(`${si} серебр.`);
  if (br || parts.length === 0) parts.push(`${br} бронзы`);
  return parts.join(' ');
};
/** Короткая строка для чипов HUD: «2П 3З 42С 5Б». */
export const coinsShort = (v: number): string => {
  const { pl, go, si, br } = coinsSplit(v);
  const parts: string[] = [];
  if (pl) parts.push(`${pl}П`);
  if (go) parts.push(`${go}З`);
  if (si) parts.push(`${si}С`);
  if (br || parts.length === 0) parts.push(`${br}Б`);
  return parts.join(' ');
};
export const PLAYER_COLORS = ['#ff5d5d', '#5aa9ff', '#35d46f', '#ffcf3f'];
export const PLAYER_NAMES = ['КРАСНЫЙ', 'СИНИЙ', 'ЗЕЛЁНЫЙ', 'ЖЁЛТЫЙ'];

/* ---------- ГЕНЕРАЦИЯ КАРТЫ ДЛЯ БЕЗКАРТОВОГО ЧЕЛЛЕНДЖА ----------
   Играть без создания карты: под капотом — линейный трек из матчей-ячеек
   (режим JOURNEY — играет только хост, остальные зрители), но экран игры
   НЕ показывает поле: вместо него — список матчей и рандомайзер.
   Карта сохраняется в библиотеку, поэтому сохранения/экспорт работают как обычно. */
export function buildMaplessMap(ch: CustomChallenge, roms: RomDef[]): GameMap {
  const r = ch.resolved;
  const romName = (id: string) => roms.find((x) => x.id === id)?.name ?? 'игра';
  const total = r.maplessRandom
    ? Math.max(1, Math.min(99, Math.floor(r.maplessCount || 25)))
    : Math.max(1, (r.maplessRomIds ?? []).length);
  const cells: CellDef[] = [
    { n: 1, x: 0, y: 0, type: 'start' },
  ];
  if (!r.maplessRandom) {
    (r.maplessRomIds ?? []).forEach((rid, i) => {
      cells.push({ n: i + 2, x: i + 1, y: 0, type: 'task', task: { romId: rid, title: romName(rid), desc: `Матч ${i + 1} из ${total} — игра по списку челленджа` } });
    });
  } else {
    for (let i = 0; i < total; i++) cells.push({ n: i + 2, x: i + 1, y: 0, type: 'task', task: null });
  }
  const pool = r.maplessRandom
    ? (r.maplessRomIds ?? []).map((rid) => ({ romId: rid, title: romName(rid) }))
    : undefined;
  const now = Date.now();
  const coinsOn = r.resCoins;
  return {
    id: `mapless-${ch.id}`,
    name: ch.name,
    cols: total + 2, rows: 2,
    mw: (total + 2) * 64, mh: 192,
    mode: 'journey1p', // играет только хост, остальные — зрители; кубиков нет
    tiles: [],
    cells,
    bonusCards: [], trapCards: [], quizzes: [],
    startMin: r.startMin, startTries: r.startTries,
    startCoins: coinsOn ? r.startCoins : undefined,
    coinsOnly: coinsOn && r.coinsOnly ? true : undefined,
    taskWinCoins: coinsOn ? r.taskWinCoins : undefined,
    skipCoins: coinsOn ? r.skipCoins : undefined,
    quizWinCoins: coinsOn ? r.quizWinCoins : undefined,
    quizLoseCoins: coinsOn ? r.quizLoseCoins : undefined,
    moveSpeed: r.speed,
    customId: ch.id,
    customName: ch.name,
    mapless: { total, random: !!r.maplessRandom, pool },
    ready: true,
    createdAt: now, updatedAt: now,
  };
}
