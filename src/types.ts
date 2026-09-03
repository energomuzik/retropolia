export type CellType = 'task' | 'bonus' | 'trap' | 'quiz';

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
}

export interface CellDef {
  n: number; // порядковый номер (1-based), он же index+1 в массиве cells
  x: number;
  y: number;
  w?: number; // ширина в клетках (по умолчанию 1) — «улицы монополии»
  h?: number; // высота в клетках (по умолчанию 1)
  type: CellType;
  task?: TaskDef | null;
  // оформление «как в монополии»: цвет группы, короткое имя, картинка
  label?: string;
  color?: string;
  imageId?: string; // dataURL картинки ячейки (видна на карте)
}

export type QuizType = 'choice' | 'text' | 'music' | 'mystery';

export interface QuizDef {
  id: string;
  type: QuizType;
  question: string;
  imageId?: string; // dataURL картинки вопроса
  options?: string[]; // 4 варианта для choice/music/mystery
  correct?: number; // индекс правильного варианта
  answers?: string[]; // допустимые написания ответа (text)
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
  | 'addTries' | 'subTries'; // попытки текущему

export interface CardEffect {
  type: EffectType;
  value: number;
  target: number; // 1-based номер игрока (для playerExtra/playerSkip)
}

export interface CardDef {
  id: string;
  kind: 'bonus' | 'trap';
  name: string;
  desc: string;
  imageId?: string;
  effect: CardEffect;
}

export interface GameMap {
  id: string;
  name: string;
  cols: number;
  rows: number;
  tiles: PlacedTile[];
  cells: CellDef[];
  bonusCards: CardDef[];
  trapCards: CardDef[];
  quizzes: QuizDef[]; // квизы карты (случайно выпадают на ячейках-квизах)
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
}

export interface SaveDef {
  id: string;
  romId: string;
  slot: number;
  name: string;
  state: unknown; // JSON снапшот jsnes
  createdAt: number;
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
  tokenImg?: string | null; // dataUrl своей фишки (PNG); null = стандартный робот
}

export interface TokenDef {
  id: string;
  name: string;
  dataUrl: string; // PNG с поддержкой прозрачности
  builtin?: boolean;
  createdAt: number;
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
  dice: { a: number; b: number; roll: number } | null;
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
  revealed: number[]; // индексы ячеек, на которые хоть раз ступали (для режима «скрытые ячейки»)
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
  emuSound: boolean; // звук эмуляторов вкл/выкл
  emuVolume: number; // 0..1 — громкость звука эмуляторов
  hideUnrevealed: boolean; // скрывать непосещённые ячейки (иконки бонусов/ловушек и картинки заданий)
  relay: string; // свой сигнальный сервер «IP:порт» (пусто = облако 0.peerjs.com)
  relayHub: string; // игровой хаб (WebSocket): весь трафик через сервер; приоритетнее PeerJS
  turn: string; // TURN для жёсткого NAT: «user:pass@host:port», несколько — через запятую (пусто = только STUN)
}

export interface NetMsg {
  mid: string;
  from: string;
  t: string;
  p?: unknown;
}

export const APP_VERSION = 4; // 4: чанковая передача карты/ромов (старые клиенты отвергаются с внятной ошибкой)
export const START_SEC = 60 * 60;
export const START_TRIES = 60;
export const SKIP_COST = 5;
export const PLAYER_COLORS = ['#ff5d5d', '#5aa9ff', '#35d46f', '#ffcf3f'];
export const PLAYER_NAMES = ['КРАСНЫЙ', 'СИНИЙ', 'ЗЕЛЁНЫЙ', 'ЖЁЛТЫЙ'];
