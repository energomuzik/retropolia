export type CellType = 'start' | 'task' | 'rest' | 'bonus' | 'trap' | 'quiz' | 'loot'; // rest — пустая клетка-передышка: ничего не происходит, ром не нужен; loot — ЯЩИК С ЛУТОМ (только RUBG): вскрывается ОТМЫЧКОЙ (мини-игра «замок») или силой (25%), разовый

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

/* ---------- v0.68 CODESEARCH: условие зачёта задания по памяти эмулятора ----------
   Создатель находит адрес (например, счётчик жизней) кнопкой CodeSearch в «Запуске
   эмулятора» и вписывает условие в задание. В игре движок сам опрашивает память
   работающего эмулятора и зачитывает задание, когда условие выполнено — как делают
   ачивки RetroAchievements, только внутри сайта и без внешнего сервиса. */
export type CodeType = 'u8' | 's8' | 'u16' | 's16' | 'u32' | 's32' | 'f32';
export type CodeOp = 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le';
/** Условие по коду: a — адрес (смещение в памяти ядра эмулятора), t — тип значения,
 *  op — оператор сравнения, v — значение. Привязано к КОНКРЕТНОМУ файлу рома. */
export interface MemCond {
  a: number;
  t: CodeType;
  op: CodeOp;
  v: number;
}

export interface TaskDef {
  romId: string;
  saveId?: string; // для SEGA-ромов слот необязателен — ядро стартует с начала
  title: string;
  desc: string;
  imageId?: string; // ключ в blobs
  chaos?: ChaosKind; // пакость: искажение эмулятора/правила, пока задание активно (1 максимум)
  joy?: JoyId; // радость: награда прошедшему задание (1 максимум)
  /* v0.55 КАСТОМНАЯ ЦЕНА ЗАДАНИЯ: награда за победу и цена проигрыша ЭТОГО задания.
   Поле не задано — применяется СТАНДАРТ ВСЕЙ КАРТЫ (taskWinCoins/skipCoins/RUBG_WIN_HP/RUBG_LOSE_HP). */
  winCoins?: number; // +бронзы за победу (QUEST/монетные режимы); нет — стандарт карты (в QUEST без настройки — 10)
  loseCoins?: number; // −бронзы за проигрыш/пропуск; нет — стандарт карты (skipCoins, по умолчанию 5)
  winHp?: number; // +% HP за победу (HP-ресурс); нет — стандарт карты (RUBG_WIN_HP = 10)
  loseHp?: number; // −% HP за проигрыш (QUEST/HP-ресурс); нет — стандарт карты (RUBG_LOSE_HP = 5)
  /* v0.68 ЗАЧЁТ ПО КОДУ (CodeSearch): условие над памятью эмулятора. Не задано —
     задание засчитывается «на доверии» кнопкой «Выполнено». Задано — игра сама
     следит за значением по адресу и зачитывает задание при выполнении условия. */
  code?: MemCond;
  /* v0.68 ПОРАЖЕНИЕ ПО КОДУ: условие поражения из CodeSearch. Выполнится — задание
     ПРОВАЛИВАЕТСЯ автоматически: RUBG/QUEST — как кнопка «Провалено» (−HP, счётчик
     провалов, полоска до нуля = поражение партии), челлендж — автоперезапуск задания. */
  codeFail?: MemCond;
  /* v0.70 ТОЛЬКО ПО КОДУ: ручные кнопки («Прошёл задание» с голосованием соперников в
     челлендже, «ПОБЕДА»/«ПОРАЖЕНИЕ» в RUBG/QUEST) для этого задания отключены —
     победа и поражение засчитываются ТОЛЬКО кодовыми условиями (code/codeFail).
     Честно для карт, где игроки не доверяют друг другу. По умолчанию флага нет —
     работает и код, и ручное подтверждение. */
  codeOnly?: boolean;
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

/* НЕВИДИМЫЕ СТЕНЫ (JOURNEY, JOURNEY SOLO, QUEST, QUEST SOLO и RUBG): прямоугольные
   зоны поля, куда фишка НЕ МОЖЕТ зайти. Ходить изначально можно везде — стены только
   исключения. В игре стены НЕ рисуются (невидимые); в редакторе — штрихуются коралловым. */
export interface WallRect {
  id?: string; // id стены (для снятия по выполнению квеста NPC); у старых стен нет — их снять нельзя
  x: number; // левый край, px поля
  y: number; // верхний край, px поля
  w: number; // ширина, px
  h: number; // высота, px
  key?: DoorKey; // v0.55 ДВЕРЬ: стена с цветом — не стена, а ЗАПЕРТАЯ ДВЕРЬ этого цвета; в игре она ВИДНА (цветная зона с замком), а фишка с КЛЮЧОМ того же цвета проходит сквозь; ключи выдаёт NPC (награда в диалоге/квесте)
}

/* v0.55 ЦВЕТНЫЕ КЛЮЧИ И ДВЕРИ: у карты 6 цветов дверей; NPC выдаёт ключ (NpcReward.key),
   фишка с ключом проходит через дверь того же цвета (стена с key). Ключ НЕ расходуется. */
export type DoorKey = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange';
export const DOOR_KEYS: { id: DoorKey; name: string; hex: string }[] = [
  { id: 'red', name: 'красный', hex: '#ff5d73' },
  { id: 'blue', name: 'синий', hex: '#5aa9ff' },
  { id: 'green', name: 'зелёный', hex: '#2ee6a8' },
  { id: 'yellow', name: 'жёлтый', hex: '#ffcf3f' },
  { id: 'purple', name: 'фиолетовый', hex: '#c07aff' },
  { id: 'orange', name: 'оранжевый', hex: '#ff8b3f' },
];
export const doorKeyHex = (k: DoorKey | string | undefined): string => DOOR_KEYS.find((x) => x.id === k)?.hex ?? '#ffcf3f';
export const doorKeyName = (k: DoorKey | string | undefined): string => DOOR_KEYS.find((x) => x.id === k)?.name ?? '';

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
  cols?: number; // v0.74: явная ШИРИНА схемы в клетках (вместе с пустыми): кнопки «+ столбец/− столбец» в схеме; нет — выводится из плиток
  rows?: number; // v0.74: явная ВЫСОТА схемы в клетках (вместе с пустыми): кнопки «+ ряд/− ряд»; нет — выводится из плиток
}
/** Размер СХЕМЫ плиток в клетках: явные cols/rows, но не меньше bounding box плиток
    (старые карты без cols/rows работают как раньше — размеры выводятся из плиток). */
export const tileGridDims = (g: TileGrid): { cols: number; rows: number } => ({
  cols: Math.max(g.cols ?? 1, ...g.tiles.map((t) => t.col + 1), 1),
  rows: Math.max(g.rows ?? 1, ...g.tiles.map((t) => t.row + 1), 1),
});
/** Прямоугольник карты-плитки в px поля. */
export const tileRectOf = (g: TileGrid, t: MapTileInfo) => ({ x: t.col * g.w, y: t.row * g.h, w: g.w, h: g.h });
/** Карта-плитка, содержащая точку поля (px); нет такой — null. */
export const tileAt = (g: TileGrid, x: number, y: number): MapTileInfo | null => {
  const col = Math.floor(x / g.w), row = Math.floor(y / g.h);
  return g.tiles.find((t) => t.col === col && t.row === row) ?? null;
};
/** Номер карты-плитки для людей (с 1, по порядку в списке). */
export const tileNumOf = (g: TileGrid, id: string): number => g.tiles.findIndex((t) => t.id === id) + 1;

/* Режим игры, задаваемый АВТОРОМ КАРТЫ в редакторе (кнопки в ВЕРХНЕЙ панели):
   classic   — RETROPOLIA: обычная настолка с кубиками (как было);
   skill     — SKILL CHALLENGE: играет только хост, у него 25 ходов; остальные подключаются и смотрят;
   journey   — JOURNEY: все фишки ходят ОДНОВРЕМЕННО (стрелки/WASD), кто первый пересёк
               ячейку задания — у того открывается задание, остальные смотрят трансляцию;
   journey1p — JOURNEY SOLO: одиночное приключение — механика JOURNEY, но играет только хост,
               все подключившиеся — зрители.
   Внутренние id НЕ менялись (старые карты и сохранения совместимы) — сменились
   только отображаемые имена (история: CLASSIC → RETROPOLIA; JOURNEY → TRIATHLON →
   JOURNEY; бывший TRIATHLON теперь тоже JOURNEY, а одиночный — JOURNEY SOLO). */
export type MapMode = 'classic' | 'skill' | 'journey' | 'journey1p' | 'rubg' | 'classic1p' | 'quest' | 'quest1p';
export const MAP_MODES: { id: MapMode; name: string; hint: string }[] = [
  { id: 'classic', name: 'RETROPOLIA', hint: 'Обычная игра с кубиками — ход по маршруту, ячейки, задания.' },
  { id: 'skill', name: 'SKILL CHALLENGE', hint: 'Играет только хост, лимит 25 ходов: остались ресурсы — челлендж пройден, нет — поражение. Каждый ход — задание: ячейки квизов, бонусов, штрафов и отдыха запрещены. Остальные игроки подключаются как зрители.' },
  { id: 'journey', name: 'JOURNEY', hint: 'Приключение на ВСЕХ: все фишки стартуют одновременно и ходят напрямую в любые стороны, кубиков и передачи хода нет. Кто ПЕРВЫМ пересечёт ячейку задания — у того оно открывается, остальные фишки замирают и смотрят трансляцию. Побеждает последний с ресурсами. Пресет: 30 мин и 30 попыток у каждого, ход фишек плавный.' },
  { id: 'journey1p', name: 'JOURNEY SOLO', hint: 'Одиночное приключение: механика JOURNEY (свободное хождение без кубиков), но играет ТОЛЬКО ХОСТ — все подключившиеся игроки становятся зрителями трансляции. Пресет: 60 мин и 60 попыток, ход фишек плавный.' },
  { id: 'rubg', name: 'RUBG', hint: 'Retro Ultimate Battle Ground — «ретро-PUBG»: все летят на самолёте и прыгают где хотят; задания играются ЛИЧНО, без остановки других и без подтверждений (доверие); ресурс один — полоска HP; безопасная зона сжимается и жжёт вне себя; ящики с лутом (взлом отмычкой), стелс, атаки и кражи. Побеждает последний живой. SOLO недоступен.' },
  { id: 'classic1p', name: 'RETROPOLIA SOLO', hint: 'RETROPOLIA на одного (галочка SOLO): кубики и маршруты, но играет ТОЛЬКО ХОСТ — остальные зрители. Победа = пройти ВСЕ задания карты; поражение — ресурсы исчерпаны.' },
  { id: 'quest', name: 'QUEST', hint: 'Квестовое приключение на ВСЕХ: все стартуют от стартовой ячейки ОДНОВРЕМЕННО и играют ИНДИВИДУАЛЬНО (трансляции между игроками нет, задания на доверие). Квизы запрещены. Побеждает тот, кто ПЕРВЫМ выполнит финальное условие-КОНЦОВКУ (собрать ресурсы / победить босса / победить N заданий / выбор в диалоге NPC). Главные механики: NPC с деревьями диалогов, квесты NPC с наградами, снятие стен по квесту. Стены и порталы работают.' },
  { id: 'quest1p', name: 'QUEST SOLO', hint: 'QUEST на одного (галочка SOLO): играет ТОЛЬКО ХОСТ — зрители смотрят трансляцию эмулятора. Победа — та же: выполнить финальное условие-КОНЦОВКУ.' },
];
/** Свободное хождение (механика JOURNEY) — JOURNEY, JOURNEY SOLO, QUEST, QUEST SOLO и RUBG. */
export const isJourneyLike = (m: MapMode | undefined): boolean => m === 'journey' || m === 'journey1p' || m === 'rubg' || m === 'quest' || m === 'quest1p';
/** Одиночные режимы: играет только хост, остальные — зрители (можно стартовать одному). */
export const isSoloMode = (m: MapMode | undefined): boolean => m === 'skill' || m === 'journey1p' || m === 'classic1p' || m === 'quest1p';
/** Квестовые режимы (QUEST / QUEST SOLO): индивидуальная игра, задания на доверие, концовки. */
export const isQuestMode = (m: MapMode | undefined): boolean => m === 'quest' || m === 'quest1p';
/** Базовый режим для кнопок верхней панели редактора (SOLO-вариант светится на базе). */
export const baseModeOf = (m: MapMode | undefined): MapMode => (m === 'classic1p' ? 'classic' : m === 'journey1p' ? 'journey' : m === 'quest1p' ? 'quest' : (m ?? 'classic'));
/** SOLO-вариант базового режима (skill всегда solo; у RUBG solo нет — null). */
export const soloVariantOf = (m: MapMode): MapMode | null => (m === 'classic' ? 'classic1p' : m === 'journey' ? 'journey1p' : m === 'quest' ? 'quest1p' : m === 'skill' ? 'skill' : null);
/** Кнопки режимов ВЕРХНЕЙ панели редактора (SOLO-варианты выбираются галочкой, не кнопками). */
export const MAP_MODES_TOP: MapMode[] = ['classic', 'journey', 'quest', 'rubg', 'skill'];

/* ---------- КЛАССИЧЕСКИЕ ПРЕСЕТЫ РЕЖИМОВ (редактор карт, верхняя панель) ----------
   Клик по режиму в верхней панели = переключение на КЛАССИЧЕСКИЙ пресет этого режима:
   параметры карты выставляются к стандарту. Если автор потом меняет параметры — режим
   помечается «ИЗМЕНЕННЫЙ» (mapModeModified). Стандарты (v0.43.0, монеты — с v0.46.0):
   • JOURNEY — 30 минут и 30 попыток у каждого; JOURNEY SOLO — 60 минут и 60 попыток;
   • QUEST и QUEST SOLO — ресурс МОНЕТЫ (старт 100 бронзы, 0 монет = вылет, победа в задании +10, пропуск −5);
   • RUBG — ресурс «полоска HP» и полное время зоны 4 часа;
   • ход фишек ВЕЗДЕ плавный (smoothMove). */
export interface ModePreset {
  startMin: number;
  startTries: number;
  resMode: 'std' | 'time' | 'tries' | 'coins' | 'hp';
  smoothMove: boolean;
  /** Ресурс «монеты» (QUEST, v0.46.0): coinsOnly = 0 монет = вылет; startCoins — стартовый капитал (бронза). */
  coinsOnly?: boolean;
  startCoins?: number;
  /** RUBG: полное время зоны, сек (14400 = 4 часа) и стандартная фаза (сужение/сжатие). */
  zoneTotalSec?: number;
  zoneDist?: number;   // сужение радиуса за сжатие, клеток
  zoneShrinkSec?: number; // длительность одного сжатия, сек
}
export const MODE_PRESETS: Record<MapMode, ModePreset> = {
  classic:   { startMin: 60, startTries: 60, resMode: 'std', smoothMove: true },
  classic1p: { startMin: 60, startTries: 60, resMode: 'std', smoothMove: true },
  skill:     { startMin: 60, startTries: 60, resMode: 'std', smoothMove: true },
  journey:   { startMin: 30, startTries: 30, resMode: 'std', smoothMove: true },
  journey1p: { startMin: 60, startTries: 60, resMode: 'std', smoothMove: true },
  quest:     { startMin: 60, startTries: 60, resMode: 'coins', coinsOnly: true, startCoins: 100, smoothMove: true },   // ← QUEST: ресурс МОНЕТЫ
  quest1p:   { startMin: 60, startTries: 60, resMode: 'coins', coinsOnly: true, startCoins: 100, smoothMove: true },  // ← QUEST SOLO: монеты
  rubg:      { startMin: 60, startTries: 60, resMode: 'hp', smoothMove: true, zoneTotalSec: 14400, zoneDist: 4, zoneShrinkSec: 25 },
};
/** Полное время зоны RUBG карты, сек — по той же формуле, что в редакторе и движке
    (фаза повторяется, пока радиус не закроется; CELL = 64 px). */
export const mapRubgZoneTotalSec = (m: { mw?: number; mh?: number; cols?: number; rows?: number; zonePhase?: { wait: number; shrink: number; dist: number }; zoneSec?: number }): number => {
  const CPX = 64;
  const W = m.mw ?? (m.cols ?? 20) * CPX;
  const H = m.mh ?? (m.rows ?? 15) * CPX;
  const r0 = Math.hypot(W, H) / 2 * 0.75;
  if (!m.zonePhase) return Math.max(30, Math.floor(m.zoneSec ?? 600)); // дефолтные фазы × zoneSec
  const dist = Math.max(0, Math.floor(m.zonePhase.dist || 0));
  const n = dist > 0 ? Math.max(1, Math.ceil(r0 / CPX / dist)) : 1;
  return n * (Math.max(0, Math.floor(m.zonePhase.wait || 0)) + Math.max(5, Math.floor(m.zonePhase.shrink || 0)));
};
/** Отличаются ли параметры карты от классического пресета её режима («ИЗМЕНЕННЫЙ»). */
export const mapModeModified = (m: Pick<GameMap, 'mode' | 'startMin' | 'startTries' | 'resMode' | 'coinsOnly' | 'startCoins' | 'smoothMove' | 'zonePhase' | 'zonePhases' | 'zoneSec' | 'mw' | 'mh' | 'cols' | 'rows'>): boolean => {
  const pr = MODE_PRESETS[m.mode ?? 'classic'];
  if (normResMode(m.resMode) !== pr.resMode) return true;
  if (!!m.smoothMove !== pr.smoothMove) return true;
  if (m.mode === 'rubg') {
    if (m.zonePhases?.length) return true; // старая пофазная настройка — уже отклонение от пресета
    return Math.abs(mapRubgZoneTotalSec(m) - (pr.zoneTotalSec ?? 600)) > 1;
  }
  if (normResMode(m.resMode) === 'std' && (m.startMin ?? 60) !== pr.startMin) return true;
  if (normResMode(m.resMode) === 'std' && (m.startTries ?? 60) !== pr.startTries) return true;
  return false;
};
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
  resHp?: boolean;                        // использовать ПОЛОСКУ HP (четвёртый ресурс; +10% за победу / −5% за поражение)
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
  resHp?: boolean;        // полоска HP как единственный ресурс (+10% за победу / −5% за поражение)
  resMode?: MapResMode;   // ЕДИНЫЙ РЕСУРС челленджа: время И попытки вместе (std) / монеты (coins) / полоска HP (hp); значения time/tries больше не выдаются (v0.50.0); нет (старые челленджи) — std (оба)
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
  const res = a.resCoins
    ? `монеты (старт ${coinsStr(a.startCoins)})`
    : a.resHp
      ? 'полоска HP (+10% за победу / −5% за поражение)'
      : `время и попытки (старт ${a.startMin} мин / ${a.startTries} поп.)`; // ОДИН ресурс из двух счётчиков (v0.50.0)
  return [`БЕЗ КАРТЫ: ${games}`, `Ресурс: ${res}`, a.resCoins ? `задание: +${a.taskWinCoins} бронзы за победу, пропуск ${a.skipCoins} бронзы` : 'без монетной экономики'];
  }
  const players = a.players === 'solo' ? 'Играет один, остальные — зрители' : a.players === 'together' ? 'Все играют одновременно' : 'Играют по очереди (кубики)';
  const field = a.field === 's' ? 'Малая карта' : a.field === 'm' ? 'Средняя карта' : a.field === 'l' ? 'Большая карта' : 'Плиточный режим (несколько карт-локаций)';
  const amount = a.cellAmount === 'few' ? 'немного ячеек (10–20)' : a.cellAmount === 'mid' ? 'средне ячеек (20–40)' : 'много ячеек (40+)';
  const res = a.resCoins
    ? `монеты (старт ${coinsStr(a.startCoins)})`
    : a.resHp
      ? 'полоска HP (+10% за победу / −5% за поражение)'
      : `время и попытки (старт ${a.startMin} мин / ${a.startTries} поп.)`; // ОДИН ресурс из двух счётчиков (v0.50.0)
  const pen = a.penalties ? `штрафы за проигрыш: −${a.loseMin} мин / −${a.loseTries} поп.; награда за победу: +${a.winMin} мин / +${a.winTries} поп.` : 'без штрафов и наград (время/попытки)';
  const coinEco = a.resCoins ? `монеты: +${a.taskWinCoins} бронзы за победу в задании, пропуск ${a.skipCoins} бронзы, квиз +${a.quizWinCoins}/−${a.quizLoseCoins} бронзы` : '';
  return [players, field, `Ячейки: ${amount}`, `Ресурс: ${res}`, pen, coinEco, `Скорость фишек: ${a.speed} кл/с`].filter(Boolean);
};

export interface PlateBg {
  bg: string; // dataUrl картинки фона ПЛИТКИ
  bgMode?: 'stretch' | 'real'; // растянуть на плитку или рисовать 1:1 от левого верхнего угла плитки
}

/* РЕСУРС ПАРТИИ (GameMap.resMode): std — «время и попытки» ОДНИМ ресурсом (время И попытки
   у каждого, вылет на нуле любого из них); coins — монеты; hp — полоска HP.
   Значения time/tries («только время» / «только попытки») БОЛЬШЕ НЕ ВЫДАЮТСЯ: с v0.50.0
   время и попытки — один нераздельный ресурс. Старые карты с time/tries работают как std
   (см. normResMode — единую точку нормализации). */
export type MapResMode = 'std' | 'time' | 'tries' | 'coins' | 'hp';
/** ЕДИНАЯ ТОЧКА НОРМАЛИЗАЦИИ РЕСУРСА ПАРТИИ: «только время» (time) и «только попытки»
 *  (tries) с v0.50.0 упразднены — время и попытки всегда работают ВМЕСТЕ как один ресурс,
 *  поэтому старые карты с resMode time/tries играются как std (оба ресурса активны).
 *  Все читатели map.resMode (движок, HUD, лобби, редакторы) обязаны идти через эту функцию. */
export const normResMode = (m?: MapResMode): MapResMode => (m === 'time' || m === 'tries' ? 'std' : (m ?? 'std'));

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
  walls?: WallRect[]; // НЕВИДИМЫЕ СТЕНЫ: зоны, куда фишке нельзя (JOURNEY, JOURNEY SOLO и RUBG); в игре не рисуются
  portals?: PortalZone[]; // ПОРТАЛЫ: зоны-телепорты между любыми точками поля (плитками); вход фишки = мгновенный перенос (JOURNEY); в игре видны мягким сиреневым свечением
  plateSize?: number; // сторона ПЛИТКИ (1024/2048/4096): поле делится на страницы-плитки; соседние стыкуются краями, любые связываются порталами; нет — карта без разбивки
  roomMode?: boolean; // РЕЖИМ КОМНАТ (АЙЗЕК): в игре видна ТОЛЬКО текущая плитка-комната — вокруг темнота, камера зажата в её границах, кнопка «Мир» и «Глянуть карту мира» скрыты; переходы задаёт создатель: ОТКРЫТЫЙ стык плиток — ходьбой (как в Айзеке), стык со СТЕНОЙ — только порталом (метроидвания — стены снимаются квестами NPC); при смене комнаты — затемнение и звук; в RUBG не действует (нужны общий план и фаза самолёта)
  hubPlate?: number; // v0.53 ХАБ-ПЛИТКА (номер с 1, как в навигаторе): комната-точка сбора — на карте мира видна ВСЕГДА, даже если ещё никто в ней не побывал (туман её не скрывает); ставится в редакторе карт, спойлер «Плитки и порталы»
  cutscenes?: CutsceneDef[]; // v0.56 КАТ-СЦЕНЫ: пролетания камеры по точкам (старт карты / зона-триггер / выдаёт NPC); во время показа все фишки, NPC и боссы стоят
  /* v0.55 SKILL CHALLENGE — два тумблера (видны ТОЛЬКО в режиме SKILL):
   skillFree — СВОБОДНОЕ ПЕРЕМЕЩЕНИЕ: хост ходит фишкой WASD/стрелками/тапом, как в JOURNEY,
   без кубиков; лимит 25 заданий сохранён — один «ход» = одно сыгранное задание;
   skillRandom — СЛУЧАЙНЫЕ ЗАДАНИЯ: вход на ячейку задания запускает задание СЛУЧАЙНОЙ
   ячейки карты (все размещённые задания перемешиваются). */
  skillFree?: boolean;
  skillRandom?: boolean;
  tileGrid?: TileGrid; // ПЛИТОЧНЫЙ РЕЖИМ КАРТ: карта из нескольких отдельных карт-плиток одинакового размера; нет — обычное (бесконечно растущее) поле
  tileBgs?: { [tileId: string]: PlateBg }; // свои фоны КАРТ-ПЛИТОК в плиточном режиме: ключ — id карты-плитки, у каждой своя «локация»
  customId?: string; // свой челлендж (мастер «Создать челлендж»), применённый к карте
  customName?: string; // имя своего челленджа — показывается в редакторе и при выборе карты
  resMode?: MapResMode; // РЕСУРС ПАРТИИ: «время и попытки» (std, ОДИН нераздельный ресурс — вылет на нуле минут ИЛИ попыток) / «монеты» (coins) / «полоска HP» (hp). Значения time/tries больше не выдаются — старые карты с ними играются как std (normResMode). RUBG всегда hp
  dlgPos?: { [nodeId: string]: { x: number; y: number } }; // СХЕМА ДЕРЕВЬЕВ ДИАЛОГОВ (граф как в ComfyUI): сохранённые позиции узлов на холсте; ключ — id узла (uid уникален в пределах карты), узлы без записи раскладываются автоматически по глубине дерева. Позиции общие для редактора карт и «Редактора квестов и диалогов»
  npcLib?: NpcLibEntry[]; // NPC, вшитые в карту (из библиотеки NPC — «Редактор анимаций и фишек», вкладка «NPC»)
  npcs?: PlacedNpc[]; // размещённые NPC: дерево диалогов, квесты с наградами, радиус звука/диалога
  endings?: MapEnding[]; // КОНЦОВКИ (QUEST): финальные условия победы; без goal — достигается только выбором в диалоге NPC
  questDefeatFails?: number; // (устарело с v0.67) раньше — поражение при N проваленных заданиях; теперь проигрыш в квесте ТОЛЬКО на нуле HP/ресурсов, поле больше не читается (в старых картах остаётся, просто игнорируется)
  zoneSec?: number; // RUBG: ПОЛНОЕ время безопасной зоны (все ожидания + сжатия) в СЕКУНДАХ; нет — 600 (10 мин). Работает ТОЛЬКО пока не заданы zonePhase/zonePhases
  zonePhases?: { wait: number; shrink: number; dist: number }[]; // RUBG: СТАРАЯ пофазная настройка (карты до v0.41): каждая фаза своя. Приоритет ниже zonePhase
  zonePhase?: { wait: number; shrink: number; dist: number }; // RUBG: ЕДИНАЯ ФАЗА для ВСЕХ сжатий: wait — пауза ДО сжатия (сек), shrink — длительность сжатия (сек), dist — сужение радиуса в КЛЕТКАХ (0 = первое же сжатие закрывает карту). Зона повторяет эту фазу, пока радиус не закроется; урон вне зоны растёт по фазам сам
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
  folder?: string; // папка в левой панели «Запусков эмулятора» (спойлер); нет — ром без папки
  cover?: string; // v0.61 ОБЛОЖКА КАРТРИДЖА: dataURL картинки (сжат до 320px, JPEG) — фото реального картриджа/карты; показывается вместо рисованного бейджа платформы и в режиме картинок
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
/* ---------- QUEST: NPC, деревья диалогов, квесты NPC и концовки ----------
   NPC — интерактивный персонаж на карте. Создаётся в «Редакторе анимаций и фишек»
   (вкладка «NPC»: клип IDLE + необязательный клип «КВЕСТ ВЫПОЛНЕН»), вшивается в карту
   и размещается как босс. У NPC есть радиус (r): внутри круга играет звук ожидания
   и доступен ДИАЛОГ. Диалог — дерево узлов: реплика NPC + варианты ответа игрока;
   вариант может выдавать награду, ставить ФЛАГ (влияет на ветки), вести в другой узел
   или ВЫБИРАТЬ КОНЦОВКУ. Квесты NPC: условие (босс / N заданий / ресурсы) + награда
   + список стен, которые СНИМАЮТСЯ при выполнении. Прогресс у КАЖДОГО игрока свой. */
export type QuestGoalKind = 'boss' | 'bosses' | 'tasks' | 'coins' | 'hp' | 'time' | 'tries' | 'deliver' | 'none';
/* ЧЕГО НУЖНО ПРИНЕСТИ/ОТДАТЬ NPC (kind='deliver'): монеты — бронза, время — секунды, попытки — штуки, HP — проценты */
export type QuestDeliverRes = 'coins' | 'time' | 'tries' | 'hp';
export interface QuestGoal {
  kind: QuestGoalKind;      // что должно быть выполнено
  bossId?: string;          // kind='boss': PlacedBoss.id — какой босс должен пасть (kind='bosses' — не нужен, считаются ЛЮБЫЕ)
  count?: number;           // 'tasks' — сколько заданий; 'bosses' — сколько боссов; 'coins' — бронзы; 'hp' — % HP; 'time' — секунд; 'tries' — попыток; 'deliver' — сколько принести
  res?: QuestDeliverRes;    // kind='deliver': какой ресурс принести/отдать NPC (по умолчанию монеты)
}
export interface MapEnding {
  id: string;
  name: string;             // название концовки («МИРНЫЙ ГЕРОЙ»)
  desc: string;             // описание — показывается на экране победы
  goal?: QuestGoal;         // финальное условие; нет/none — концовка достигается только ВЫБОРОМ в диалоге NPC
}
export interface NpcReward {
  coins?: number; // бронзы (монетный режим)
  min?: number;   // минут
  tries?: number; // попыток
  key?: DoorKey;  // v0.55: ЦВЕТНОЙ КЛЮЧ — открывает дверь (стену с key того же цвета); не расходуется
}
export interface NpcQuest {
  id: string;
  title: string;
  desc: string;
  goal: QuestGoal;          // условие выполнения
  reward: NpcReward;        // награда за сдачу квеста
  removeWalls?: string[];   // id стен, СНИМАЕМЫХ при выполнении квеста
}
export interface DialogOption {
  text: string;             // ответ игрока (кнопка в диалоге)
  next?: string;            // перейти в узел дерева; нет — диалог завершается
  give?: NpcReward;         // выдать награду при выборе
  setFlag?: string;         // поставить флаг (влияет на ветки и концовки)
  reqFlag?: string;         // вариант виден ТОЛЬКО с этим флагом
  reqNotFlag?: string;      // вариант виден ТОЛЬКО без этого флага
  ending?: string;          // выбор определяет КОНЦОВКУ: без goal — немедленная победа; с goal — выбранный путь
  tpCell?: number;          // v0.54: NPC ОТНОСИТ игрока к этой ячейке при выборе варианта (индекс в map.cells) — мгновенный перенос, как через портал
  cutscene?: string;        // v0.56: NPC ПОКАЗЫВАЕТ КАТ-СЦЕНУ при выборе варианта (id из map.cutscenes) — камера летит по маршруту, мир замирает
}
export interface DialogNode {
  id: string;
  text: string;             // реплика NPC
  opts?: DialogOption[];    // варианты ответа; нет/пусто — конец диалога
  showShop?: boolean;       // v0.51: на этом узле в игре показывается кнопка «Торговать» (окно торговли); авто-ветка «Можно ли поторговать с тобой?» создаётся при добавлении торговли
  showQuests?: boolean;     // v0.51: на этом узле в игре показывается список квестов NPC (со сдачей); авто-ветка «Есть ли для меня работа?» создаётся при добавлении квеста
  /* v0.54 (НАОБОРОТ к v0.53): по умолчанию КАЖДАЯ реплика пишется всегда; автор по
     желанию ставит ПИН на узле — тогда виденная реплика схлопывается в «…уже слышали»
     (тумблер игрока «сказанное скрыто»). СТАРТОВЫЙ узел диалога пин игнорирует:
     приветствие NPC всегда пишется целиком, даже если уже было сказано. */
  pinHide?: boolean;
}
export interface NpcDialog {
  root: string;             // id стартового узла
  nodes: DialogNode[];
}
/* ТОВАР NPC-МАГАЗИНА: вещь из каталога предметов (kind='item', цена в бронзе) или ресурс
   (kind='res': +N минут/попыток/% HP). Покупка — за монеты В ОКНЕ ТОРГОВЛИ NPC (v0.51);
   работает только когда на карте включены монеты (map.startCoins задан). */
export interface NpcShopOffer {
  id: string;
  kind: 'item' | 'res';     // вещь или ресурс
  item?: RubgItemKind;      // kind='item': вещь из каталога RUBG_ITEMS (аптечка, фляжка, отмычка…)
  res?: 'time' | 'tries' | 'hp'; // kind='res': какой ресурс продаёт NPC
  amount?: number;          // kind='res': сколько ресурса (минут / попыток / % HP)
  title?: string;           // своё название товара; нет — берётся из каталога/ресурса
  price: number;            // цена в бронзе (монетный режим)
  qty?: number;             // v0.51: сколько единиц на витрине торговца (партия съедает запас); нет/0 — БЕЗ ЛИМИТА (как раньше)
}
/* v0.51: СКИДКА ЗА ХОРОШЕЕ ОТНОШЕНИЕ — игрок сдал квест → цены этого NPC для него ниже на pct %.
   Скидки СУММИРУЮТСЯ по всем выполненным квестам NPC, потолок — 90 %. */
export interface NpcDiscount {
  questId: string;          // NpcQuest.id (квест любого NPC карты)
  pct: number;              // 1..90 — сколько процентов снимает выполненный квест
}
/* v0.52: ПАТРУЛИРОВАНИЕ — персонаж (NPC или босс) ХОДИТ ПО КАРТЕ по точкам-маршруту.
   pts — точки маршрута в px поля (обходится ПО КРУГУ: 1→2→…→N→1); speed — скорость
   px/сек; pause — пауза в каждой точке, сек. Движение чисто визуальное и детерминированное:
   позиция считается формулой от s.startedAt (patrolPos) — без сетевых сообщений.
   Точка 1 — «дом» персонажа: в редакторе он стоит там же, где размещён. */
export interface PatrolDef {
  pts: { x: number; y: number }[];
  speed?: number;           // px/сек (по умолчанию 40)
  pause?: number;           // сек ожидания в каждой точке (по умолчанию 1)
}

/* v0.56 КАТ-СЦЕНЫ — кинематографичные пролетания камеры по точкам карты.
   Во время кат-сцены ВСЕ фишки, NPC и боссы стоят, камера летит по маршруту:
   в каждой точке можно ЗАДЕРЖАТЬСЯ (wait, сек) и приблизить/отдалить (zoom —
   множитель обычного зума слежения: 1 = как в игре, 2 = вдвое ближе, 0.5 = дальше).
   Запуск: ① при СТАРТЕ карты (если создатель задал), ② когда игрок ВПЕРВЫЕ
   за сессию пересекает ЗОНУ-триггер, ③ NPC показывает кат-сцену вариантом диалога. */
export interface CutscenePt {
  x: number; y: number;   // точка фокуса камеры (px поля)
  wait?: number;          // сколько секунд камера стоит в точке (0–30, по умолчанию 1)
  zoom?: number;          // множитель зума в точке (0.4–3, по умолчанию 1)
}
export interface CutsceneDef {
  id: string;
  name: string;                 // название для редактора («Пролог», «Замок босса»…)
  pts: CutscenePt[];            // маршрут камеры (минимум 1 точка)
  trigger: 'start' | 'zone' | 'npc'; // когда играть: старт карты / зона-триггер / выдаёт NPC
  zone?: { x: number; y: number; w: number; h: number }; // для trigger='zone': прямоугольник-триггер
  npcId?: string;               // для trigger='npc': какой NPC показывает (проверка в диалоге)
  skippable?: boolean;          // можно пропустить удержанием Esc ~1 с (v0.62 — без постоянной надписи; по умолчанию да)
  speed?: number;               // скорость перелёта камеры px/сек (по умолчанию 420)
}
export interface PlacedNpc {
  id: string;
  nid: string;              // ссылка на NpcLibEntry в map.npcLib
  x: number; y: number;     // центр в px поля
  w: number; h: number;     // размер в px
  r?: number;               // радиус звука и диалога (px); 0/нет — молчит и не говорит
  dialog?: NpcDialog;       // дерево диалогов
  quests?: NpcQuest[];      // квесты NPC (СКОЛЬКО УГОДНО — v0.51 каждый новый квест ещё и ветку диалога «Есть работа?» выращивает)
  shop?: NpcShopOffer[];    // ТОРГОВЛЯ: товары и цены NPC (окно торговли за монеты)
  shopCoins?: number;       // v0.51: КАССА торговца — сколько монет он готов потратить на ВЫКУП вещей игрока; нет — выкуп выключен (только продажа)
  sellPct?: number;         // v0.51: сколько процентов от справочной цены (cost каталога RUBG_ITEMS) торговец платит за вещи игрока; нет — 50 %
  discounts?: NpcDiscount[]; // v0.51: скидки за хорошее отношение — выполненные квесты снижают цены
  patrol?: PatrolDef;       // v0.52: ПАТРУЛЬ — ходит по точкам маршрута (как боссы); нет — стоит на месте
}
export interface NpcAnimDef {
  id: string;
  name: string;
  idle: AnimClip;   // обязательный клип — NPC стоит
  idleSnd?: string; // звук ожидания (играет по радиусу, как у боссов/анимаций)
  done?: AnimClip;  // клип «КВЕСТ ВЫПОЛНЕН»: NPC играет его, когда все его квесты СДАНЫ игроком
  doneSnd?: string; // звук выполненного квеста
  createdAt: number;
}
export interface NpcLibEntry {
  id: string;
  name: string;
  idle: AnimClip;
  idleSnd?: string;
  done?: AnimClip;
  doneSnd?: string;
}
/* Снимок NPC для вшивания в карту (как bossLibEntryOf) */
export const npcLibEntryOf = (b: NpcAnimDef): NpcLibEntry => ({
  id: b.id,
  name: b.name,
  idle: JSON.parse(JSON.stringify(b.idle)),
  ...(b.idleSnd ? { idleSnd: b.idleSnd } : {}),
  ...(b.done ? { done: JSON.parse(JSON.stringify(b.done)) } : {}),
  ...(b.doneSnd ? { doneSnd: b.doneSnd } : {}),
});
/* Человекочитаемое описание цели квеста/концовки (редактор + диалоги в игре) */
export const questGoalText = (g: QuestGoal | undefined, map: Pick<GameMap, 'bossLib' | 'bosses'>): string => {
  if (!g || g.kind === 'none') return 'без условия (только выбор в диалоге)';
  if (g.kind === 'boss') {
    const b = (map.bosses ?? []).find((x) => x.id === g.bossId);
    const def = b ? (map.bossLib ?? []).find((x) => x.id === b.bid) : undefined;
    return `победить босса «${def?.name ?? '?'}»`;
  }
  if (g.kind === 'bosses') {
    const nb = Math.max(1, Math.floor(g.count ?? 1));
    return `победить ${nb} ${nb % 10 === 1 && nb % 100 !== 11 ? 'босса' : 'боссов'} (любых)`;
  }
  const n = Math.max(1, Math.floor(g.count ?? 1));
  if (g.kind === 'tasks') return `победить ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'задание' : 'заданий'} на карте`;
  if (g.kind === 'coins') return `собрать ${coinsShort(n)} монет`;
  if (g.kind === 'hp') return `иметь ${n}% HP`;
  if (g.kind === 'time') return `запас времени ≥ ${Math.max(1, Math.round(n / 60))} мин`;
  if (g.kind === 'tries') return `запас попыток ≥ ${n}`;
  if (g.kind === 'deliver') {
    if (g.res === 'time') return `отдать NPC ${Math.round(n / 60)} мин времени`;
    if (g.res === 'tries') return `отдать NPC ${n} попыток`;
    if (g.res === 'hp') return `отдать NPC ${n}% HP`;
    return `принести NPC ${coinsShort(n)} монет`;
  }
  return `запас попыток ≥ ${n}`; // страховка (выше 'tries' обработан явно)
};

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
  patrol?: PatrolDef; // v0.52: ПАТРУЛЬ — босс ходит по точкам, пока жив; повержённый замирает в точке гибели
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
   Вместо бонусов/штрафов — ЯЩИКИ с лутом (взлом отмычкой/силой): хилки, оружие,
   отмычки, карты воровства и стелса. */
export type RubgItemKind = 'flask' | 'medkit' | 'bigmed' | 'pistol' | 'smg' | 'sniper' | 'steal' | 'stealth' | 'lockpick';
export interface RubgItem {
  id: string;
  kind: RubgItemKind;
  uses?: number; // карта воровства: 3 использования
  belt?: boolean; // на ПОЯСЕ (экранный слот, максимум 3); нет — в общем инвентаре (кнопка «Инвентарь»); с пояса предметы используются, из инвентаря — только надеваются; пояс НЕ воруется
}
export const RUBG_ITEMS: Record<RubgItemKind, { name: string; hp: number; radius: number; loot: number; icon: string; cost: number }> = {
  // hp — урон/лечение в ПРОЦЕНТАХ полоски; radius — радиус атаки в клетках (0 — не оружие); loot — вес в лут-таблице
  // cost (v0.51) — СПРАВОЧНАЯ цена в бронзе: торговец платит sellPct % от неё при ВЫКУПЕ вещи у игрока
  flask:    { name: 'Фляжка',            hp: 10,  radius: 0,  loot: 24, icon: '🥃', cost: 15 },
  medkit:   { name: 'Аптечка',           hp: 25,  radius: 0,  loot: 16, icon: '🧰', cost: 40 },
  bigmed:   { name: 'Ящик медбрата',     hp: 75,  radius: 0,  loot: 6,  icon: '📦', cost: 120 },
  pistol:   { name: 'Пистолет',          hp: 5,   radius: 3,  loot: 14, icon: '🔫', cost: 80 },
  smg:      { name: 'Пистолет-пулемёт',  hp: 15,  radius: 6,  loot: 10, icon: '💥', cost: 150 },
  sniper:   { name: 'Снайперка',         hp: 40,  radius: 12, loot: 5,  icon: '🎯', cost: 300 },
  steal:    { name: 'Карта воровства',   hp: 0,   radius: 0,  loot: 11, icon: '🤏', cost: 60 }, // 3 использования
  stealth:  { name: 'Карта стелса',      hp: 0,   radius: 0,  loot: 5,  icon: '👻', cost: 90 },
  lockpick: { name: 'Отмычка',           hp: 0,   radius: 0,  loot: 14, icon: '🔑', cost: 50 }, // взлом ящиков (мини-игра «замок»); ломается при промахе фиксации
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
export const RUBG_BELT_SLOTS = 3;   // слотов ПОЯСА: предметы на экране; остальное — в общем инвентаре
export const RUBG_STOP_CD = 15;      // кулдаун кнопки «Остановить вора», секунд
export interface RubgZonePhasePlan {        // РАБОЧИЙ ПЛАН ФАЗЫ (пересчитан в px поля при создании зоны)
  wait: number;                             // пауза до сжатия, СЕКУНД (абсолютных, без масштабирования)
  shrink: number;                           // длительность сжатия, СЕКУНД
  dps: number;                              // урон ВНЕ зоны в эту фазу (% HP/с)
  distPx: number;                           // на сколько px поля сузится радиус (0 = без сужения)
}
export interface RubgZone {
  cx: number; cy: number; r: number;        // ТЕКУЩИЙ круг (px поля) — пересчитывается хостом каждый тик
  sx: number; sy: number; sr: number;       // ОТКУДА сжимаемся (начало текущей фазы сжатия)
  tx: number; ty: number; tr: number;       // цель сжатия (куда сожмётся)
  phase: 'wait' | 'shrink';                 // ждём или сжимаемся
  phaseStart: number; phaseEnd: number;     // границы фазы, Date.now() хоста (клиенты рисуют интерполяцией)
  idx: number;                              // номер фазы (0..плана.length-1)
  dps: number;                              // урон ВНЕ зоны в секунду (% HP)
  lastTick: number;                         // момент прошлого подсчёта урона
  plan?: RubgZonePhasePlan[];               // ПЛАН ВСЕХ ФАЗ (создаётся при появлении зоны: авторские zonePhases или дефолт, пересчитанный в px). Старые сессии без плана — фолбэк на RUBG_ZONE_PHASES×масштаб
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
export interface RubgShot {               // ВЫСТРЕЛ: летящая пуля (рисуют все клиенты)
  id: string;                             // уникальный идентификатор (для звука без повторов)
  from: string;                           // id стрелка (позиция — journeyPos)
  to: string;                             // id цели
  kind: RubgItemKind;                     // пистолет / ПП / снайперка — скорость и звук трассера
  ts: number;                             // Date.now() хоста в момент выстрела
}
export interface RubgState {
  plane?: RubgPlane;                       // фаза полёта (rollOff): все прыгнули → playing
  zone: RubgZone | null;                   // безопасная зона (появляется при старте партии)
  jobs?: Record<string, RubgJob>;          // ЛИЧНЫЕ задания: key — id игрока
  looted?: number[];                       // индексы ВСКРЫТЫХ ящиков (одноразовые)
  stealth?: string[];                      // кто в стелсе сейчас
  steals?: Record<string, RubgSteal>;      // активные кражи: key — id ЖЕРТВЫ
  stopCd?: Record<string, number>;         // кулдаун «Остановить вора»: key — игрок, значение — ts последнего нажатия
  shots?: RubgShot[];                      // последние выстрелы (летящие пули; хост чистит старые)
  boxBan?: Record<string, number[]>;       // ящики, ЗАКРЫТЫЕ НАВСЕГДА для игрока (провал «открыть силой»): key — id игрока
}
export const RUBG_ZONE_PHASES: { wait: number; shrink: number; mul: number; dps: number }[] = [
  { wait: 40, shrink: 30, mul: 0.65, dps: 1 },
  { wait: 30, shrink: 25, mul: 0.6,  dps: 2 },
  { wait: 25, shrink: 20, mul: 0.55, dps: 4 },
  { wait: 20, shrink: 15, mul: 0.5,  dps: 8 },
  { wait: 15, shrink: 15, mul: 0.45, dps: 12 },
  { wait: 10, shrink: 20, mul: 0,    dps: 20 }, // финал: карта вся в запретной зоне
];
/* Суммарное время зоны при масштабе 1 (сумма всех ожиданий и сжатий, 265 с ≈ 4.4 мин).
   Настройка карты zoneSec (минуты+секунды в редакторе) растягивает/сжимает ВСЕ фазы
   пропорционально: scale = zoneSec / RUBG_ZONE_TOTAL. */
export const RUBG_ZONE_TOTAL: number = RUBG_ZONE_PHASES.reduce((acc, p) => acc + p.wait + p.shrink, 0);
export const RUBG_ZONE_DEFAULT_SEC = 600; // зона по умолчанию: 10 минут — не «в мгновение ока», как было
/* Человекочитаемое время зоны для логов: «Х мин Y с» или «Y с» */
export const rubgFmtZone = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s} с`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} мин ${r} с` : `${m} мин`;
};
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
  mode: 'time' | 'tries' | 'coins' | 'hp' | null; // hp — ресурс «полоска HP»: плата по итогам (+10% победа / −5% поражение)
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
  /* ---------- QUEST / QUEST SOLO: индивидуальная игра — весь прогресс У КАЖДОГО СВОЙ ---------- */
  qJobs?: Record<string, { cellIdx: number; startedAt: number }>; // ЛИЧНЫЕ задания: key — id игрока (вход в ячейку задания)
  qDone?: Record<string, number[]>; // выполненные задания: id игрока → индексы ячеек (для целей «N заданий»)
  qBossDown?: Record<string, string[]>; // побеждённые боссы: id игрока → PlacedBoss.id (босс жив, пока его НЕ победил конкретный игрок)
  qFlags?: Record<string, Record<string, boolean>>; // флаги выборов в диалогах: id игрока → { флаг: true }; 'quest:<id>' = квест NPC сдан; 'ending:<id>' = выбран путь концовки
  qFails?: Record<string, number>; // провалы заданий: id игрока → счётчик (для лога; с v0.67 поражения по лимиту провалов НЕТ — выбывает только по HP/ресурсам)
  npcShop?: { [npcId: string]: { coins?: number; qty?: { [offerId: string]: number } } }; // v0.51 ТОРГОВЛЯ: живое состояние витрин (запас товаров и касса NPC); заводится при первой сделке с NPC — qty отсутствует у товаров БЕЗ лимита
  qCards?: Record<string, CardDef>; // выпавшая карточка (бонус/ловушка) игроку: key — id игрока, ждёт подтверждения
  /* v0.52: УЖЕ СКАЗАННОЕ — узлы диалогов, чей текст игрок УЖЕ ВИДЕЛ (key — id игрока → id узла).
   Ставится в dialogPick (узел, с которого выбран ответ, и узел, куда перешли).
   По нему работает тумблер «скрывать сказанное» в окне диалога: уже прочитанные
   реплики схлопываются в «…уже слышали» (кнопка «показать» возвращает текст).
   v0.53: живёт ТОЛЬКО в текущей партии/сессии — новая партия стартует с чистого
   листа; возвращается к игроку только при восстановлении из сохранения (это часть
   сохранённого состояния). v0.54: сворачиваются ТОЛЬКО реплики с ПИНОМ автора
   (DialogNode.pinHide) — остальные пишутся всегда; стартовый узел не сворачивается
   никогда, даже с пином. */
  dlgSeen?: Record<string, Record<string, number>>;
  /* v0.53: ОТКРЫТЫЕ КОМНАТЫ, синхронизированные между игроками (номера плиток с 1).
   Пишет хост: каждый клиент, впервые войдя в комнату, шлёт action plateSeen —
   хост объединяет, все видят общий туман исследования на карте мира. */
  openPlates?: number[];
  /* v0.53: момент победы игрока над боссом в QUEST (id игрока → id босса → Date.now() хоста).
   Повержённый босс замирает в точке гибели и больше не патрулирует — ДЛЯ ПОБЕДИТЕЛЯ. */
  qBossDownAt?: Record<string, Record<string, number>>;
  /* v0.53: момент последнего ЗАХВАТА игрока патрульным боссом (id игрока → Date.now()).
   Захват: босс в патруле догоняет игрока — тот переносится на ПЕРВУЮ ТОЧКУ ПАТРУЛЯ босса.
   Антиспам: после захвата босс не может схватить того же игрока CAPTURE_CD мс. */
  qCaptureAt?: Record<string, number>;
  /* v0.54: «ЗАМОРОЗКА» ПАТРУЛЯ босса (id игрока → id босса → Date.now() хоста).
   Ставится, когда игрок открыл диалог рядом с боссом (босс ЖДЁТ конца разговора) и
   при ЗАХВАТЕ (после поимки босс перестаёт патрулировать). Босс рисуется для этого
   игрока замершим в точке holdTs. Снимается: игрок проиграл задание на ячейке босса —
   босс снова патрулирует; игрок победил — босс повержен (qBossDownAt). */
  qBossHoldAt?: Record<string, Record<string, number>>;
  /* v0.55 ЦВЕТНЫЕ КЛЮЧИ (id игрока → список цветов): выдаёт NPC наградой (диалог/квест).
   Фишка с ключом цвета K проходит через ДВЕРЬ цвета K (стена с key). Ключ не расходуется. */
  qKeys?: Record<string, string[]>;
  /* v0.55 ячейка, на которую игрока ОТТАЩИЛ БОСС (id игрока → индекс ячейки): её проход
   НЕ срабатывает сразу после оттаскивания (никаких карточек/передышек), сбрасывается при выходе */
  qCaptureCell?: Record<string, number>;
  /* v0.55 КУЛЛДАУН захвата (id игрока → метка «до какого времени босс не ловит»):
   ставится на 6 с при самом захвате и на 8 с после ПРОИГРЫША задания босса —
   чтобы сразу не попасть в лапы заново. */
  qCaptureCd?: Record<string, number>;
  /* v0.56 кто ПОСЛЕДНИМ ПОЙМАЛ игрока (id игрока → id босса): задание босса
   стартует ОТЛОЖЕННО — когда фишку ДОТАЩИЛИ до точки и прошла 1 секунда. */
  qCaptureBoss?: Record<string, string>;
  /* v0.56 запланированный момент запуска задания босса (id игрока → Date.now()):
   захват + длительность плавного оттаскивания + 1 секунда задержки. Клиент
   пойманного игрока шлёт bossTaskGo, когда фишка на месте — хост сверяет время. */
  qTaskAt?: Record<string, number>;
  /* v0.56 КАТ-СЦЕНЫ «уже показанные» (ключ → ts): для зоны-триггера и старта карты —
   играется ОДИН раз за сессию (старт карты: ключ start:cutId общий; зона: playerId:cutId).
   Часть сейва: при загрузке сохранения кат-сцены заново не навязываются. */
  cutsceneDone?: Record<string, number>;
  /* v0.56 сигнал «ИГРАЙ КАТ-СЦЕНУ» (NPC показывает её вариантом диалога): клиент
   игрока pid играет кат-сцену id локально. Мимолётное поле — только свежий ts играется. */
  cutscenePlay?: { id: string; pid: string; ts: number };
  wallsRemoved?: string[]; // id стен, СНЯТЫХ выполнением квестов NPC — фишка ходит сквозь них
  ending?: { playerId: string; endingId: string } | null; // достигнутая КОНЦОВКА (победа в QUEST)
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
  scanlines: boolean; // v0.56 ПОЛОСАТЫЙ ФИЛЬТР (сканлайны CRT): тонкие горизонтальные полосы поверх всего сайта; в полном экране эмулятора полосы накладываются отдельным слоем (не пропадают)
  ntsc: boolean; // v0.56 УСТАРЕВШЕЕ ПОЛЕ (только для миграции старых настроек): прежняя галочка NTSC; при загрузке сохранённых опций превращается в ntscMode (true → 1, false → 0)
  ntscMode: 0 | 1 | 2; // v0.58 NES NTSC ФИЛЬТР — ВЫБОР в общих опциях, ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН (0): 1 «Полосатый» (старый фильтр v0.56: RGB-триады, лёгкое мерцание) · 2 «Мягкий CRT» (v0.57: мягкость кадра, тёплые цвета — применяется ВНУТРИ эмулятора к самому кадру, работает в полном экране); полосатый фильтр (сканлайны CRT) — отдельная опция scanlines, включён по умолчанию
  ntscReset: boolean; // v0.58 ОДНОКРАТНЫЙ СБРОС NTSC: при первом setOptions после обновления фильтр гасится у всех (миграция v0.57 и выборы v0.56–v0.57 больше не держат его включённым); после сброса явный выбор пользователя сохраняется как обычно
  cutBars: 'dissolve' | 'classic'; // v0.57 ПОЛОСЫ КАТ-СЦЕН — выбор в общих опциях: dissolve — «растворяющиеся» в стиле PS1 Resident Evil / Dino Crisis 2 (СПЛОШНЫЕ полосы с чётким краем ПЛАВНО проявляются, растворяя кадр в чёрный, и в конце кат-сцены плавно тают) — ПО УМОЛЧАНИЮ; v0.61 — плавный градиентный переход между чёрным и картинкой УБРАН, край резкий как у «Резких»; classic — прежние выезжающие полосы (тоже получили плавный уход в конце вместо мгновенного исчезновения)
  spoilerMode: SpoilerMode; // v0.70/v0.71 СПОЙЛЕРЫ: remember — запоминать свёрнутость каждого (папки ромов в «Запуске эмулятора» и редакторе заданий, спойлер сохранений, панели и группы тайлов в редакторе карт) — ПО УМОЛЧАНИЮ; collapsed — при входе в редактор все свёрнуты; expanded — при входе все развёрнуты; режим задаёт только СТАРТ — после входа спойлеры свободно переключаются руками
}

export type SpoilerMode = 'remember' | 'collapsed' | 'expanded';

export interface NetMsg {
  mid: string;
  from: string;
  t: string;
  p?: unknown;
}

export const APP_VERSION = 67; // 67: ПЯТЬ ОБНОВЛЕНИЙ ПО ВАШИМ ЗАДАЧАМ. (1) «РАЗБИТЬ ПОЛЕ НА ПЛИТКИ» ТЕПЕРЬ ЗАПОЛНЯЕТ СХЕМУ: кнопка режет поле на КАРТЫ-ПЛИТКИ и вся сетка (nx×ny) сразу появляется в схеме «Карты-плитки» — не по одной; сторона — стандартная, дающая до 24 плиток, у маленького поля — 2×2 пополам; прежняя разбивка «страницами одного поля» (и режим комнат «Айзек» с хабом) осталась второй кнопкой в «Плитках и порталах». (2) ПУСТЫЕ РЯДЫ И СТОЛБЦЫ СХЕМЫ: у схемы появились кнопки «+ столбец / + ряд» (пустой столбец справа / ряд снизу — туда можно переставить или добавить плитку) и «− столбец / − ряд» (убирают пустой край); перестановка плитки больше НЕ СХЛОПЫВАЕТ схему — ряд, из которого ушла последняя плитка, остаётся на месте (рамку схемы строите сами: хоть 6 вправо и 3 вниз); явные размеры схемы хранятся в карте (TileGrid.cols/rows), старые карты без них работают как раньше. (3) ПЛАВНОЕ ПЕРЕТАСКИВАНИЕ ПЛИТОК: зажатая плитка сразу ПРИПОДНИМАЕТСЯ (масштаб + тень + бирюзовое кольцо), за курсором едет призрак «КАРТА N → сюда», а после отпускания плитка АНИМИРОВАННО (280 мс) доезжает до нового слота — и в схеме, и на весь экран (обмен анимируются у обеих плиток). (4) LCD-ЦВЕТА ПРИСТАВОК — КАК В ПОДСКАЗКАХ: «Создание игры» красит платформы в те же цвета, что названия приставок в лаунчере/редакторе заданий (PlatName): NES и Game Boy/Color — серый dim, вся семья SEGA (Mega Drive/Master System) — синий sky, SNES — светлый paper, GBA — фиолет, 32X — красный, Atari — оранжевый, PC Engine — золотой, GAME GEAR — пурпур этикетки. (5) ДУБЛИ РОМОВ ПРИ ЗАГРУЗКЕ ПАПКИ: «Загрузить папку» пропускает файл, если ром с ТАКИМ ЖЕ ИМЕНЕМ ФАЙЛА уже есть в базе (в любой папке) или уже попал в эту загрузку — без md5 и прочих проверок (хаки и изменённые версии с другим именем добавляются); в сообщении — сколько дубликатов пропущено. // 66 (история): ТРИ ОБНОВЛЕНИЯ ПО ВАШИМ ЗАДАЧАМ. (1) НОВАЯ КАРТА-ПЛИТКА НЕ ВЫЛЕЗАЕТ ЗА КРАЙ СХЕМЫ: свободный слот ищется только в границах схемы (col ≥ 0, row ≥ 0) в порядке право → низ → лево → верх → диагонали, дальше — ближайший к выбранной плитке свободный слот (раньше плитка могла встать слева от №1 — col −1 — вне поля и вне схемы). (2) ПЕРЕТАСКИВАНИЕ ПЛИТОК: в схеме «Карты-плитки» ЛКМ-зажатие — перетащить плитку на свободный слот или обменять с другой; содержимое (ячейки, штампы, стены, порталы с зонами и точками, анимации, боссы) едет вместе, Ctrl+Z возвращает; кнопка «⛶ Весь экран» — полноэкранная карта плиток: ПКМ — панорама, колесо — масштаб, ЛКМ — выбор, ЛКМ-зажатие — перетаскивание с призраком. (3) LCD-ИНДИКАЦИЯ В «СОЗДАНИИ ИГРЫ»: платформы ромов заданий (все 10 систем проекта в цветах своих картриджей), квизы, бонусы, ловушки, пустые ячейки и ресурс партии показываются индикаторами «как лампочка»: тускло видно всегда, наличные горят ярко со свечением; фильтр «Консоль» — по всем семьям: NES/SEGA/SNES/GB-GBC/GBA/Atari/PCE. // 65 (история): ТРИ ОБНОВЛЕНИЯ ПО ВАШЕМУ ОТЧЁТУ. (1) ПЕРЕВОДЧИК ЦИФР ПОЧИНЕН: клик по кандидату больше не запускает «первый поиск заново» и не теряет значение — раньше из-за React-замыкания «искать 115» реально искало старый ввод строки поиска (например «3»), и фильтр среди найденных потом давал 0; теперь: поиска нет — первый поиск (тип «1 байт»), сессия уже идёт — кандидат ищется СРЕДИ НАЙДЕННЫХ, тип поиска сохраняется, ничего не сбрасывается; подписи кнопок честные: «искать N» / «среди найденных: N». (2) СТЕНА КОДА — КНОПКА «📌 ЗАКРЕПИТЬ ПОД ИГРОЙ»: стена уезжает в панель ВНИЗУ ЭКРАНА и живёт поверх страницы эмулятора при свёрнутом CodeSearch — изменения байт видно прямо во время игры; на панели адрес/переход/шаги/«живой»/счётчик заморозки, кнопка «CodeSearch» (развернуть окно) и «⇱ Вернуть в окно» (она же в окне стены). (3) КНОПКИ ЗУМА В РЕДАКТОРАХ: в редакторе карт в панели инструментов и над превью карты в редакторе заданий — кнопки «−»/%/«＋» (и сброс «100%» в превью): зум без колеса мыши, шаг ×1,25, клик по проценту — возврат на 100%; колесо и «Вся карта» работают как раньше. // 64 (история): ТРИ ОБНОВЛЕНИЯ ПО ВАШЕЙ КРИТИКЕ. (1) СПОЙЛЕРЫ — РЕЖИМ РАБОТАЕТ ТОЛЬКО ПРИ ВХОДЕ: «Всегда свёрнуты»/«Всегда развёрнуты» задают стартовое состояние в момент входа в редактор (папки ромов, спойлер сохранений, панели, группы тайлов), дальше всё свободно переключается руками — раньше режим зажимал спойлеры навсегда; «Запоминать» — как раньше. (2) ОДИНАКОВЫЕ УСЛОВИЯ НА ПОБЕДУ И ПОРАЖЕНИЕ ЗАПРЕЩЕНЫ: если в «Зачёт по коду» и «Поражение по коду» вставлен один и тот же код (адрес+тип+оператор+значение), редактор заданий показывает предупреждение и блокирует сохранение — поражение проверяется первым, зачёт по коду был бы недостижим. (3) ПЕРЕВОДЧИК ЦИФР В CODESEARCH: некоторые игры хранят число кодом — Darkwing Duck держит в памяти НОМЕР ТАЙЛА цифры (тайлы цифр 0–9 начинаются с 0x70, поэтому 3 жизни = 0x73 = 115 и поиск «3» пуст); переводчик превращает число с экрана в кандидатов — как есть, счёт от единицы, тайлы 0x70/0x60/0x50/0xa0/0xb0, ASCII, BCD — у каждого кнопка «искать» (1 байт, первый поиск заново); обратный перевод: найденный байт 115 расшифровывается как «тайл цифры 3 — как в Darkwing Duck»; если кандидаты не находятся — «Неизвестное значение» (снимок → изменилось/уменьшилось) находит величину при любом кодировании. // 63 (история): ПЯТЬ ОБНОВЛЕНИЙ ПО ВАШЕЙ КРИТИКЕ. (1) СТЕНА КОДА — ПРАВКА БАЙТОВ НА МЕСТЕ: клик по любому hex-байту в живом дампе CodeSearch открывает поле ввода — вписывайте значение (десятичное или 0x-hex) прямо в стену: рядом с жизнями так же правятся соседние счётчики игры; у каждого байта подсказка «DEC 115 · 0x73», записанный байт подсвечивается красным как изменившийся. (2) ЗАДАНИЕ «ТОЛЬКО ПО КОДУ»: в редакторе заданий галочка у кодовых условий — ручные кнопки («Прошёл задание» с голосованием в челлендже, «ПОБЕДА/ПОРАЖЕНИЕ» в RUBG/QUEST) для этой ячейки отключены, всё решают ТОЛЬКО коды CodeSearch — карты для тех, кто не доверяет соперникам; в челлендже зачёт по коду при этой галочке — МГНОВЕННЫЙ (без голосования «Согласен/Нарушил»). По умолчанию — как было: и по коду, и вручную. (3) ТИП ЗАДАНИЙ ВИДНО ЗАРАНЕЕ: в лобби на плитке карты и в комнате — строка «задания: вручную / с голосованием / по коду / ТОЛЬКО по коду / всё вместе» — игроки знают правила до старта. (4) ПКМ — ВСТАВКА В ПОЛЯХ: правая кнопка в любом поле ввода (коды RPC1 в редакторе заданий, адреса хаба/реле/TURN в Опциях, названия) снова открывает меню браузера с «Вставить» и «Копировать» — на канвасах ПКМ по-прежнему свободна для игры. (5) СПОЙЛЕРЫ — РЕЖИМ В ОПЦИЯХ («Редакторы»): «Запоминать» (по умолчанию — что свернули, то закрыто и после перезахода; папки ромов, спойлер сохранений, панели и группы тайлов в редакторе карт) · «Всегда свёрнуты» · «Всегда развёрнуты»; заодно исправлено: сворачивание ГРУПП ТАЙЛОВ теперь сохраняется в карту (раньше терялось, если не трогать канвас). // 62 (история): CODESEARCH — СВЁРТЫВАНИЕ И ПОСЛЕДОВАТЕЛЬНОСТИ. (1) КНОПКА «СВЕРНУТЬ» (▾) в окне CodeSearch: окно сворачивается в плашку в углу экрана, поиск/результаты/заморозка ЖИВУТ — играйте в игру и разворачивайте обратно, чтобы фильтровать по новому значению (раньше окно закрывали и всё пропадало); закрытие при активном поиске — двухшаговое («✕!» на втором клике). (2) ПОСЛЕДОВАТЕЛЬНОСТИ (как «пользовательский тип» ArtMoney): 2–4 числа через пробел в строке значения — первый поиск находит места, где они лежат в памяти ПОДРЯД (HP и максимум рядом); фильтр принимает столько же чисел, операторы сравнивают каждую позицию, «изменилось/выросло/…» — все позиции; в результатах видна вся цепочка, ✏/❄/🎯 — на первом значении. (3) БАГФИКС: операторы фильтра «≠ > < ≥ ≤» не работали (тип FilterKind их не знал — фильтр всегда обнулял список); исправлено.
// 61: CODESEARCH — ПОИСК ПО ПАМЯТИ ЭМУЛЯТОРА И ЗАЧЁТ ЗАДАНИЙ ПО КОДУ (как у ачивок RetroAchievements, но внутри сайта и без внешнего сервиса). (1) КНОПКА CODESEARCH в «Запуске эмулятора» (рядом с «Управлением»): открывает окно поиска по ЖИВОЙ памяти запущенной игры в стиле ArtMoney — первый поиск по точному значению (5 жизней) → значение меняется в игре (жизней стало 4) → «искать среди найденных» → повторять, пока не останутся 1–3 адреса; типы значений: 1/2/4 байта, знаковые и дробное (float); режим «НЕИЗВЕСТНОЕ ЗНАЧЕНИЕ» (снимок памяти + фильтры «изменилось/не изменилось/выросло/уменьшилось» — когда число не видно на экране); найденный адрес можно ПРАВИТЬ (проверка: поменялись жизни — адрес верный), ЗАМОРОЗИТЬ (значение вписывается обратно автоматически) и посмотреть в «СТЕНЕ КОДА» — живой дамп памяти (адрес · 16 байт в hex · символы, изменённые байты подсвечены). Игра при поиске продолжает работать. (2) УСЛОВИЕ ЗАДАНИЯ ПО КОДУ: найденный адрес превращается в КОД УСЛОВИЯ (RPC1:АДРЕС:ТИП:ОПЕРАТОР:ЗНАЧЕНИЕ, операторы = ≠ > < ≥ ≤) — код вставляется в редакторе заданий («Зачёт по коду — CodeSearch»); теперь игра САМА следит за памятью работающего эмулятора (опрос раз в полсекунды) и зачитывает задание при выполнении условия: челлендж — как «Выполнено» (голосование соперников как обычно), личные задания RUBG и QUEST — мгновенно с пометкой «ЗАЧТЕНО ПО КОДУ 🤖» в журнале. (2б) ПОРАЖЕНИЕ ПО КОДУ: в редакторе заданий второе поле «Поражение по коду — CodeSearch» — условие провала: выполнится — задание ПРОВАЛИТСЯ САМО: RUBG/QUEST — как кнопка «Провалено» (−HP, счётчик провалов; нулевая полоска = поражение партии, в журнале «ПОРАЖЕНИЕ ПО КОДУ 🤖»), челлендж — автоперезапуск задания; поражение проверяется ПЕРВЫМ (оба условия совпали разом — провал). Условие привязано к конкретному файлу рома и встроенному ядру. (3) RetroAchievements из недостроенной v0.68 ПОЛНОСТЬЮ СНЯТА (файлы ra.ts, RaGoalBox.tsx удалены, движок/редакторы/Опции очищены) — схема с внешним сервисом не подошла. // 60 (история): ТРИ ИЗМЕНЕНИЯ. (1) ПРОИГРЫШ В QUEST — ТОЛЬКО НА НУЛЕ HP: лимит проваленных заданий («поражение при N провалах», напр. 5 проигрышей боссу) УБРАН — ни quest, ни quest solo не выбивают за провалы (задание проваливай сколько угодно — босс унесёт фишку, HP теряется только за сам проигрыш); партия проигрывается только когда полоска HP упадёт до нуля (или у std-карт кончатся время/попытки); счётчик провалов остался в логе, настройка удалена из обоих редакторов. (2) ДЕФОЛТНЫЕ ОБЛОЖКИ КАРТРИДЖЕЙ — ФОТОГРАФИИ РЕАЛЬНЫХ КАРТРИДЖЕЙ на прозрачном фоне (вместо рисованных): платформа по ФОРМАТУ рома, вариант по РЕГИОНУ в имени файла — NES: (U)/(USA)→NES, (J)/(Jap)→Famicom, (P)/(pirate)→Dendy; SEGA: (U)/(USA)→Genesis, иначе (EU/JP)→Mega Drive; SNES: (J)→Super Famicom, иначе→SNES США; SMS/GG/32X/GB/GBA/Atari 2600/PCE HuCARD — по формату; своя обложка (📷) главнее дефолтной. (3) «GAME GEAR» БОЛЬШЕ НЕ ЗАДВОЕНА в подсказке «Запуска эмулятора». // 59 (история): ДВА ИСПРАВЛЕНИЯ ПО ВАШЕЙ КРИТИКЕ. (1) БАГФИКС «НИЧЬЯ» ПРИ ПРОВАЛЕ КВЕСТА: вылет по лимиту провалов заданий (5 проигрышей боссу и т.п.), нулю HP или ресурсам раньше показывал классический финал «ПОБЕДА · НИЧЬЯ» вместо поражения — теперь честное «QUEST ПРОВАЛЕН» с именем выбывшего и причиной (провалов X из допускаемых Y / нулевая полоска HP / ресурсы). (2) КНОПКИ КАРТИНОК — ПОД КАРТИНКУ: 📷 ✂ ✕ убраны с картинки плитки режима картинок и переехали в нижнюю полосу, на место надписи названия картриджа (название рядом) — в лаунчере, в окне картинок и в редакторе заданий. // 58 (история): ПЯТЬ ОБНОВЛЕНИЙ. (1) ПОЛОСЫ «РАСТВОРЯЮЩИХСЯ» НИЖЕ — 10vh вместо 13vh в кат-сценах («Резкие» не тронуты). (2) КИНО-ЗАХВАТ БОССА: при поимке игрока включаются те же полосы кат-сцены («управление у босса»); босс с доп. анимацией (рывок-«схватил» + бобыление) САМ НЕСЁТ фишку к первой точке патруля, фишка едет рядом и барахтается с красной вспышкой; после прибытия полосы плавно уходят и стартует задание — управление вернули; страховка по времени, проигрыш задания — босс снова патрулирует. (3) ПЛАТФОРМЫ В СВОИХ ЦВЕТАХ: SEGA — синий, Game Boy/Color — серый, GAME GEAR — пурпур, 32X — красный, Atari — оранжевый и т.д. (4) «УДАЛИТЬ ВСЕ СОХРАНЕНИЯ» в «Загрузить игру» — все партии разом, режим удаления из Опций + Ctrl+Z. (5) БАЗА РОМОВ одним файлом в «Запуске эмулятора»: «Сохранить базу» (ромы + обложки) и «Загрузить базу» (слияние, без дублей). (1) ПОЛОСЫ «РАСТВОРЯЮЩИХСЯ» НИЖЕ — 10vh вместо 13vh в кат-сценах («Резкие» не тронуты). (2) КИНО-ЗАХВАТ БОССА: при поимке игрока включаются те же полосы кат-сцены («управление у босса»); босс с доп. анимацией (рывок-«схватил» + бобыление) САМ НЕСЁТ фишку к первой точке патруля, фишка едет рядом и барахтается с красной вспышкой; после прибытия полосы плавно уходят и стартует задание — управление вернули; страховка по времени, проигрыш задания — босс снова патрулирует. (3) ПЛАТФОРМЫ В СВОИХ ЦВЕТАХ: SEGA — синий, Game Boy/Color — серый, GAME GEAR — пурпур, 32X — красный, Atari — оранжевый и т.д. (4) «УДАЛИТЬ ВСЕ СОХРАНЕНИЯ» в «Загрузить игру» — все партии разом, режим удаления из Опций + Ctrl+Z. (5) БАЗА РОМОВ одним файлом в «Запуске эмулятора»: «Сохранить базу» (ромы + обложки) и «Загрузить базу» (слияние, без дублей). // 57: БАГФИКС — «БЕЛЫЙ ЭКРАН» ПРИ ВЫРЕЗАНИИ КАРТИКОВ: окно ✂ падало сразу после открытия — размер вырезанного тайла снимался в отложенном обновлении состояния, где объект события React уже обнулён (currentTarget = null); ошибка сносила всё приложение. Теперь размеры снимаются сразу в обработчике. // 56: ДВА ОБНОВЛЕНИЯ ПО ВАШЕЙ КРИТИКЕ. (1) УБИРАНИЕ ОБЛОЖЕК — ПО ПРАВИЛАМ УДАЛЕНИЯ ИЗ РЕДАКТОРА КАРТ: крестик ✕ у обложки картриджа (в лаунчере, в плитках режима картинок и в редакторе заданий) теперь подчиняется режиму удаления из Опций — мгновенно, с подтверждением или удержанием с полоской, как крестики тайлов и «Удалить все сохранения»; случайно убрали — Ctrl+Z вернёт обложку на место. (2) ВЫРЕЗАТЕЛЬ КАРТИКОВ = ВЫРЕЗАТЕЛЬ ТАЙЛОВ: окно ✂ переделано — теперь это ТОТ ЖЕ вырезатель, что режет тайлы из листа в редакторе карт: фон АВТО/палитра/пипетка, допуск, мин. размер, склейка частей, мелкий текст; нарезка пересчитывается на лету, из найденных тайлов КЛИКОМ выбирается обложка рома — пропорции честные (HuCARD остаётся вертикальной, широкий картридж SEGA — широким), прозрачный фон остаётся прозрачным; рамка-кроппер с соотношениями сторон из v0.62 убрана.
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
