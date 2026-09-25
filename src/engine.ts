import type { CardDef, GameFx, GameMap, GameOptions, GameSession, MapMode, NpcReward, PlayerState, QuestGoal, RubgItemKind, RubgZonePhasePlan, TaskDef, TradeOffer, TokenDir } from './types';
import { APP_VERSION, SKIP_COST, SKIP_COINS_DEFAULT, COINS_MAX, START_SEC, START_TRIES, JOY_LIST, mkJoyCard, SKILL_TURNS, isJourneyLike, isSoloMode, isQuestMode, questGoalText, tileAt, tileRectOf, coinsStr, RUBG_ITEMS, RUBG_HP_MAX, RUBG_WIN_HP, RUBG_LOSE_HP, RUBG_ZONE_PHASES, RUBG_ZONE_TOTAL, RUBG_ZONE_DEFAULT_SEC, rubgFmtZone, RUBG_STEAL_RANGE, RUBG_STOP_CD, RUBG_BELT_SLOTS, rubgMkItem, rubgRandomKind, playerPx } from './types';
import type { RubgItem } from './types';
import type { JoyId } from './types';
import { CELL, cellAtPoint, cellCenter, hopTargetOf, prevCellOf, startCellIdx, stepNext, stepPrev } from './render';

/* ПЛИТОЧНЫЙ РЕЖИМ КАРТ: пружка фишки НЕ может покинуть СВОЮ карту-плитку.
   Возвращает координаты, зажатые в прямоугольник карты-плитки, где стоит точка
   (или в прямоугольник точки (fx,fy), если исходная — вне любой плитки).
   tileGrid нет — координаты без изменений (обычное бесконечное поле). */
function clampToTile(map: GameMap, x: number, y: number, fx: number, fy: number): { x: number; y: number } {
  const tg = map.tileGrid;
  if (!tg) return { x, y };
  const t = tileAt(tg, fx, fy) ?? tileAt(tg, x, y);
  if (!t) return { x, y }; // вне всех плиток (не должно случаться) — обычный клэмп поля
  const r = tileRectOf(tg, t);
  return {
    x: Math.max(r.x + 8, Math.min(r.x + r.w - 8, x)),
    y: Math.max(r.y + 8, Math.min(r.y + r.h - 8, y)),
  };
}
/** Режим разрешает стены/порталы со свободным хождением? */
export const modeAllowsWalls = (m: MapMode | undefined): boolean => isJourneyLike(m);

export type Action =
  | { t: 'hello'; id: string; name: string }
  | { t: 'ready'; id: string; ready: boolean }
  | { t: 'kick'; id: string }
  | { t: 'start' }
  | { t: 'roll'; id: string; holdMs: number }
  | { t: 'rollOffGo' }
  | { t: 'rollOffReady'; id: string }
  | { t: 'resume'; snap: { state: GameSession; mapName: string }; claims: Record<string, string> }
  | { t: 'arrived'; id: string }
  | { t: 'chooseMode'; id: string; mode: 'time' | 'tries' | 'coins' }
  | { t: 'startTask'; id: string }
  | { t: 'togglePause'; id: string }
  | { t: 'token'; id: string; tokenImg: string | null; tokenId?: string; tokenSize?: number }
  | { t: 'reloadSave'; id: string }
  | { t: 'declareDone'; id: string }
  | { t: 'approve'; id: string }
  | { t: 'violate'; id: string }
  | { t: 'skip'; id: string; instant: boolean; spentMs: number; loads: number; resource?: 'time' | 'tries' | 'coins' }
  | { t: 'postChoice'; id: string; choice: 'continue' | 'end' }
  | { t: 'setCellTask'; id: string; cellIdx: number; task: TaskDef; cardId?: string }
  | { t: 'useCard'; id: string; cardId: string }
  | { t: 'immuneSkip'; id: string; emu: 'nes' | 'sega' | 'any' }
  | { t: 'tradeOffer'; id: string; to: string; cardId?: string; cellIdx?: number; priceMin: number; priceTries: number }
  | { t: 'tradeReply'; id: string; offerId: string; kind: 'accept' | 'counter' | 'decline'; counterMin?: number; counterTries?: number }
  | { t: 'tradeResolve'; id: string; offerId: string; accept: boolean }
  | { t: 'quizAnswer'; id: string; answer: number | string | null; sentAt?: number }
  | { t: 'quizTarget'; id: string; target: string }
  | { t: 'quizTimeout' }
  | { t: 'quizDone'; id: string }
  | { t: 'cardAck'; id: string }
  | { t: 'journeyMove'; id: string; x: number; y: number; dir?: TokenDir; mv?: boolean; tp?: boolean } // JOURNEY: позиция СВОЕЙ фишки — любой игрок ходит одновременно (авторитет — хост); mv=false — фишка встала; tp — обновление несёт ПРЫЖОК ЧЕРЕЗ ПОРТАЛ (анти-телепорт не применять)
  | { t: 'fxDone'; id: string } // анимация fx (победа/поражение) у игрока закончилась — можно продолжать ход
  | { t: 'fxBreak'; id: string } // спектакль победы дошёл до разбития ячейки (пауза 1 с прошла — анимации начались)
  | { t: 'maplessSpin'; id: string; cellIdx: number; romId: string; title: string } // БЕЗ КАРТЫ: рандомайзер остановился — хост записывает выпавшую игру в матч
  | { t: 'maplessOpen'; id: string; cellIdx: number } // БЕЗ КАРТЫ: хост открывает следующий матч (задание на ячейке)
  | { t: 'maplessFinish'; id: string } // БЕЗ КАРТЫ: все матчи сыграны — хост завершает партию победой (после анимаций)
  | { t: 'rubgJump'; id: string; x: number; y: number } // RUBG: прыжок из самолёта в точку (x,y — под самолётом в момент нажатия)
  | { t: 'rubgTick'; id: string } // RUBG: тик хоста (~1 с): фазы зоны, урон вне зоны, форс-высадка, финал
  | { t: 'rubgJobDone'; id: string; cellIdx: number; win: boolean } // RUBG: игрок сам закрыл ЛИЧНОЕ задание (доверие): win — победа (+HP+лут), false — поражение (−HP)
  | { t: 'rubgJobLeave'; id: string; cellIdx: number } // RUBG: игрок ушёл из личного задания без последствий
  | { t: 'rubgUseItem'; id: string; itemId: string } // RUBG: использовать хилку (+HP)
  | { t: 'rubgShoot'; id: string; itemId: string; targetId: string } // RUBG: выстрел по цели (играющему — 100%, идущему — шанс от расстояния); все видят летящую пулю
  | { t: 'rubgBoxHack'; id: string; cellIdx: number; itemId: string } // RUBG: игрок взломал ЯЩИК отмычкой (мини-игра «замок» пройдена): отмычка сгорает, лут выдается
  | { t: 'rubgBoxBreak'; id: string; cellIdx: number; itemId: string } // RUBG: фиксация мимо верхней точки — отмычка СЛОМАНА (ящик остаётся закрытым)
  | { t: 'rubgBoxForce'; id: string; cellIdx: number } // RUBG: открыть СИЛОЙ — шанс 25%; провал закрывает этот ящик для игрока НАВСЕГДА
  | { t: 'rubgStealStart'; id: string; victimId: string; holdMs: number } // RUBG: отпустил кнопку кражи — старт мини-игры «карман» (holdMs = сколько держал)
  | { t: 'rubgStealPick'; id: string; victimId: string; itemId: string } // RUBG: выбрал предмет из кармана жертвы
  | { t: 'rubgStealFail'; id: string; victimId: string } // RUBG: время вышло — кража провалена (стелс слетает)
  | { t: 'rubgStopThief'; id: string } // RUBG: жертва нажала «Остановить вора» (кулаул 15 с)
  | { t: 'rubgStealth'; id: string } // RUBG: активировать стелс (сгорает карта стелса)
  | { t: 'rubgBelt'; id: string; itemId: string; on: boolean } // RUBG: надеть/снять предмет с ПОЯСА (на поясе макс. 3 — только они имеют кнопки действий; пояс не воруется)
  | { t: 'qJobDone'; id: string; cellIdx: number; win: boolean } // QUEST: игрок закрыл ЛИЧНОЕ задание (доверие): победа — награда и прогресс, поражение — плата и счётчик провалов
  | { t: 'qJobLeave'; id: string; cellIdx: number } // QUEST: игрок ушёл из личного задания без последствий
  | { t: 'qCardAck'; id: string } // QUEST: игрок подтвердил выпавшую карточку бонуса/ловушки
  | { t: 'dialogPick'; id: string; npcId: string; nodeId: string; optIdx: number } // QUEST: выбор игрока в диалоге NPC (награда/флаг/переход/концовка)
  | { t: 'npcClaim'; id: string; npcId: string; questId: string } // QUEST: сдача квеста NPC — награда + снятие стен

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const rnd6 = () => 1 + Math.floor(Math.random() * 6);

function mkPlayer(id: string, name: string, color: number, isHost: boolean): PlayerState {
  return {
    id, name: name.slice(0, 14).toUpperCase() || 'ИГРОК', color, ready: isHost, isHost,
    secLeft: START_SEC, triesLeft: START_TRIES, coinsLeft: 0, hp: RUBG_HP_MAX, pos: 0, alive: true, skipTurns: 0, extraTurn: false,
    inventory: [], oneDie: false, dicePlus: false, freeSkip: false, joyTurn: -1,
  };
}

/* Нормализация новых полей игрока (сессии от старых версий их не содержат) */
function normPlayer(p: PlayerState) {
  if (!Array.isArray(p.inventory)) p.inventory = [];
  if (p.oneDie === undefined) p.oneDie = false;
  if (p.dicePlus === undefined) p.dicePlus = false;
  if (p.freeSkip === undefined) p.freeSkip = false;
  if (p.joyTurn === undefined) p.joyTurn = -1;
  if (p.spect === undefined) p.spect = false;
  if (p.coinsLeft === undefined) p.coinsLeft = 0;
  if (p.hp === undefined) p.hp = RUBG_HP_MAX;
  if (!Array.isArray(p.items)) p.items = [];
  if (p.stealth === undefined) p.stealth = false;
}

const CELL_PX = CELL; // клетка сетки поля

/* прямоугольник ячейки в px поля (для JOURNEY: «фишка пересекла ячейку»;
   экспорт — GameScreen использует для «ящика рядом» и открытых ящиков) */
export function cellRectOf(map: GameMap, idx: number) {
  const c = map.cells[idx];
  if (!c) return null;
  if (c.cx !== undefined && c.cy !== undefined) {
    const w = c.cw ?? CELL_PX, h = c.ch ?? CELL_PX;
    return { x: c.cx - w / 2, y: c.cy - h / 2, w, h };
  }
  return { x: c.x * CELL_PX, y: c.y * CELL_PX, w: (c.w || 1) * CELL_PX, h: (c.h || 1) * CELL_PX };
}

/* НЕВИДИМЫЕ СТЕНЫ (JOURNEY): точка (центр фишки) внутри стены?
   Стены хранятся углом (x,y — левый верх) + размер; ходить можно везде, кроме них. */
function pointInWall(map: GameMap, x: number, y: number, removed?: string[]): boolean {
  for (const w of map.walls ?? []) {
    if (w.id && removed?.includes(w.id)) continue; // стена СНЯТА выполнением квеста NPC
    if (x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h) return true;
  }
  return false;
}

export function newSession(code: string, mapId: string, hostId: string, hostName: string): GameSession {
  return {
    v: APP_VERSION, code, mapId, usedQuizzes: [], phase: 'lobby',
    players: [mkPlayer(hostId, hostName, 0, true)],
    rollOffIdx: 0, rollOffValues: {}, rollOffReady: [], turn: 0,
    dice: null, moving: null, challenge: null, pendingCard: null, quiz: null, notice: null,
    captured: {}, sessionTasks: {}, trades: [], awaitPost: false, revealed: [],
    winner: null, log: [`Комната ${code} открыта. Ждём игроков…`], startedAt: Date.now(),
  };
}

export const cellTaskOf = (s: GameSession, map: GameMap, idx: number): TaskDef | null =>
  s.sessionTasks[idx] ?? map.cells[idx]?.task ?? null;

export function spentInfo(ch: NonNullable<GameSession['challenge']>, nowMs: number) {
  const running = ch.mode === 'time' && ch.started && !ch.paused && ch.startedAt > 0;
  const ms = ch.accMs + (running ? nowMs - ch.startedAt : 0);
  const min = Math.floor(ms / 60000);
  const units = ch.mode === 'tries' ? ch.loads : ch.mode === 'time' ? min : 0;
  return { ms, min, loads: ch.loads, units, canSkip: units >= SKIP_COST };
}

export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

type Log = (t: string) => void;

export function applyAction(s0: GameSession, a: Action, map: GameMap, opts: GameOptions): GameSession {
  /* Восстановление партии: полная замена сессии на сохранённую с переназначением
     игроков (claims: currentId -> savedId). Непризванные сохранённые игроки выбывают. */
  if (a.t === 'resume') {
    if (s0.phase !== 'lobby') return s0;
    const base = clone(a.snap.state);
    base.v = APP_VERSION;
    base.code = s0.code;
    if (s0.mapId && base.mapId && base.mapId !== s0.mapId) return s0; // другая карта — не восстанавливаем
    const claims = a.claims ?? {};
    const claimedBy = new Map<string, string>(); // savedId -> currentId
    for (const [curId, savedId] of Object.entries(claims)) claimedBy.set(savedId, curId);
    /* Автоназначение: подключённым игрокам без заявки (сообщение потерялось или
       не успело) раздаём оставшиеся роли по порядку. Без этого восстановление
       могло оставить «лишних» игроков вне партии. */
    const claimedCurIds = new Set(Object.keys(claims));
    const freeLobby = s0.players.filter((p) => !claimedCurIds.has(p.id));
    const freeSaved = base.players.filter((p) => !claimedBy.has(p.id));
    freeLobby.forEach((lp, i) => {
      const sp = freeSaved[i];
      if (sp) claimedBy.set(sp.id, lp.id);
    });
    const hostCurId = s0.players.find((p) => p.isHost)?.id;
    base.players = base.players
      .filter((p) => claimedBy.has(p.id))
      .map((p) => {
        const curId = claimedBy.get(p.id)!;
        const lobbyP = s0.players.find((x) => x.id === curId);
        return { ...p, id: curId, isHost: curId === hostCurId, name: lobbyP?.name ?? p.name, tokenImg: lobbyP?.tokenImg ?? p.tokenImg, ready: true };
      });
    if (base.players.length === 0) return s0;
    const savedTurnId = a.snap.state.players[a.snap.state.turn % a.snap.state.players.length]?.id;
    const targetCurId = savedTurnId ? claimedBy.get(savedTurnId) : undefined;
    const ti = targetCurId ? base.players.findIndex((p) => p.id === targetCurId) : 0;
    base.turn = ti < 0 ? 0 : ti;
    base.moving = null; base.challenge = null; base.pendingCard = null; base.quiz = null;
    base.notice = null; base.dice = null; base.sealedDice = null; base.awaitPost = false;
    if (base.phase !== 'over') base.phase = 'playing';
    /* Полная нормализация: сохранение могло быть сделано старой версией игры,
       где части полей ещё не существовало. Без этого игровой экран молча падал
       (например, на s.revealed.includes) и выглядело это как «карты нет». */
    base.revealed = Array.isArray(base.revealed) ? base.revealed : [];
    base.usedQuizzes = Array.isArray(base.usedQuizzes) ? base.usedQuizzes : [];
    base.sessionTasks = base.sessionTasks ?? {};
    base.captured = base.captured ?? {};
    base.rollOffValues = base.rollOffValues ?? {};
    base.rollOffIdx = base.rollOffIdx ?? 0;
    base.rollOffWinner = base.rollOffWinner ?? null;
    base.turnNo = base.turnNo ?? 1;
    base.winner = base.winner ?? null;
    base.trades = Array.isArray(base.trades) ? base.trades : [];
    base.journeyPos = base.journeyPos ?? {};
    if (base.skillDone !== undefined && !Array.isArray(base.skillDone)) base.skillDone = [];
    base.fxs = Array.isArray(base.fxs) ? base.fxs : [];
    base.broken = base.broken ?? {};
    base.bossDown = base.bossDown ?? {};
    base.qJobs = base.qJobs ?? {};
    base.qDone = base.qDone ?? {};
    base.qBossDown = base.qBossDown ?? {};
    base.qFlags = base.qFlags ?? {};
    base.qFails = base.qFails ?? {};
    base.qCards = base.qCards ?? {};
    base.wallsRemoved = Array.isArray(base.wallsRemoved) ? base.wallsRemoved : [];
    base.ending = base.ending ?? null;
    for (const pl of base.players) normPlayer(pl);
    base.log = [`♻️ Партия восстановлена из сохранения (игроков: ${base.players.length})`, ...(Array.isArray(base.log) ? base.log : [])].slice(0, 50);
    return base;
  }

  const s = clone(s0);
  // старые сохранённые сессии могут не иметь новых полей
  if (!s.usedQuizzes) s.usedQuizzes = [];
  if (s.quiz === undefined) s.quiz = null;
  if (s.turnNo === undefined) s.turnNo = 1;
  if (s.sealedDice === undefined) s.sealedDice = null;
  if (!Array.isArray(s.rollOffReady)) s.rollOffReady = [];
  if (!Array.isArray(s.revealed)) s.revealed = [];
  if (!s.sessionTasks) s.sessionTasks = {};
  if (!s.captured) s.captured = {};
  if (!s.rollOffValues) s.rollOffValues = {};
  if (s.rollOffWinner === undefined) s.rollOffWinner = null;
  if (!Array.isArray(s.log)) s.log = [];
  if (!Array.isArray(s.trades)) s.trades = [];
  if (s.skillDone !== undefined && !Array.isArray(s.skillDone)) s.skillDone = [];
  if (s.journeyPos === undefined) s.journeyPos = {};
  if (!Array.isArray(s.fxs)) s.fxs = [];
  if (!s.broken) s.broken = {};
  if (!s.bossDown) s.bossDown = {};
  if (!s.qJobs) s.qJobs = {};
  if (!s.qDone) s.qDone = {};
  if (!s.qBossDown) s.qBossDown = {};
  if (!s.qFlags) s.qFlags = {};
  if (!s.qFails) s.qFails = {};
  if (!s.qCards) s.qCards = {};
  if (!Array.isArray(s.wallsRemoved)) s.wallsRemoved = [];
  if (s.ending === undefined) s.ending = null;
  if (s.rubg !== undefined) {
    // старые сессии RUBG без части полей
    s.rubg.jobs = s.rubg.jobs ?? {};
    s.rubg.looted = s.rubg.looted ?? [];
    s.rubg.stealth = s.rubg.stealth ?? [];
    s.rubg.steals = s.rubg.steals ?? {};
    s.rubg.stopCd = s.rubg.stopCd ?? {};
  }
  for (const pl of s.players) normPlayer(pl);
  const log: Log = (t) => { s.log = [t, ...s.log].slice(0, 50); };
  /* ЗРИТЕЛИ (SKILL CHALLENGE): подключены и смотрят, но не играют — ходов
     им не достаётся, выбывание по ресурсам их не касается, победитель — не они */
  const alive = () => s.players.filter((p) => p.alive && !p.spect);
  const aid = 'id' in a ? (a as { id: string }).id : '';
  const actor = () => s.players.find((p) => p.id === aid);
  const current = () => s.players[s.turn % s.players.length];

  const nextTurn = () => {
    const al = alive();
    /* SKILL CHALLENGE: играет ОДИН хост — «остался один» это норма; конец партии
       только по исчерпанию ресурсов (поражение) или по лимиту 25 ходов (пройдено) */
    if (al.length === 0 || (al.length <= 1 && map.mode !== 'skill')) {
      s.phase = 'over';
      s.winner = al[0]?.id ?? null;
      if (s.winner) log(`🏆 ${al[0].name} — ПОБЕДИТЕЛЬ!`);
      return;
    }
    const cur = current();
    if (cur && cur.alive && cur.extraTurn) {
      cur.extraTurn = false;
      log(`${cur.name}: дополнительный ход!`);
      return;
    }
    let idx = s.turn % s.players.length;
    for (let g = 0; g < s.players.length * 8; g++) {
      idx = (idx + 1) % s.players.length;
      const np = s.players[idx];
      if (!np.alive || np.spect) continue;
      if (np.skipTurns > 0) {
        np.skipTurns--;
        log(`${np.name} пропускает ход`);
        continue;
      }
      break;
    }
    s.turn = idx;
  };

  const checkElim = () => {
    /* монеты-единственный ресурс (coinsOnly): вылетает тот, у кого кончились МОНЕТЫ;
       в смешанном режиме монеты не убивают — вылет по времени+попыткам как раньше */
    const coinsFatal = map.coinsOnly === true && map.startCoins !== undefined;
    const isRubg = map.mode === 'rubg';
    const hpRes = isRubg || map.resMode === 'hp'; // ресурс «полоска HP» — вылет по нулю HP (RUBG и карты с выбором «HP»)
    const resM = map.resMode ?? 'std';
    const failsLimit = map.questDefeatFails && map.questDefeatFails > 0 ? Math.floor(map.questDefeatFails) : 0; // QUEST: поражение при N провалах
    for (const p of s.players) {
      const out = hpRes
        ? (p.hp ?? RUBG_HP_MAX) <= 0 // HP-ресурс: единственный ресурс — полоска HP
        : resM === 'time' ? p.secLeft <= 0 // ОДИН ресурс «время» (мастер челленджа) — попытки не считаются
        : resM === 'tries' ? p.triesLeft <= 0 // ОДИН ресурс «попытки»
        : coinsFatal ? (p.coinsLeft ?? 0) <= 0 : (p.secLeft <= 0 && p.triesLeft <= 0 && (!coinsFatal || (p.coinsLeft ?? 0) <= 0));
      const failedOut = !out && failsLimit > 0 && isQuestMode(map.mode) && (s.qFails?.[p.id] ?? 0) >= failsLimit;
      if (p.alive && !p.spect && (out || failedOut)) {
        p.alive = false;
        if (s.challenge && current().id === p.id) s.challenge = null;
        if (s.pendingCard && s.pendingCard.player === p.id) s.pendingCard = null;
        if (s.rubg?.jobs) delete s.rubg.jobs[p.id]; // личное задание мёртвого закрывается
        if (s.qJobs) delete s.qJobs[p.id]; // QUEST: личное задание мёртвого закрывается
        if (s.qCards) delete s.qCards[p.id];
        s.awaitPost = false;
        s.moving = null;
        log(failedOut
          ? `💀 ${p.name} выбывает — провалов заданий ${s.qFails?.[p.id] ?? 0} из допускаемых ${failsLimit}`
          : hpRes ? `💀 ${p.name} ВЫБЫВАЕТ — полоска HP на нуле!` : `💀 ${p.name} выбывает — ${coinsFatal ? 'монеты исчерпаны' : 'ресурсы исчерпаны'}`);
        if (map.mode === 'skill' && p.isHost) log(`❌ SKILL CHALLENGE ПРОВАЛЕН: ресурсы исчерпаны до ${SKILL_TURNS} ходов`);
        if (map.mapless && p.isHost) log(`❌ ЧЕЛЛЕНДЖ ПРОВАЛЕН: ресурсы исчерпаны на матче ${(s.mapless?.done ?? 0) + 1} из ${s.mapless?.total ?? '?'}`);
      }
    }
    questWinCheck();
    const al = alive();
    /* В ОДИНОЧНЫХ режимах (JOURNEY-на-одного, SKILL CHALLENGE) один живой игрок —
       НОРМА: партия не заканчивается после каждого задания. Финал одинокой партии:
       ресурсы исчерпаны (вылет, al.length === 0) — поражение; в безкартовом челлендже
       победу приносит maplessFinish после всех матчей. Фикс: раньше одиночный JOURNEY
       «побеждал» после первого же пройденного задания. */
    if (s.phase === 'playing' && (al.length === 0 || (al.length <= 1 && !isSoloMode(map.mode)))) {
      s.phase = 'over';
      s.winner = al[0]?.id ?? null;
      if (s.winner) log(`🏆 ${al[0].name} — ПОБЕДИТЕЛЬ!`);
      return;
    }
    if (!current().alive && s.phase === 'playing') nextTurn();
  };

  /* ---------- QUEST / QUEST SOLO: цели, концовки, награды ----------
     questGoalsDone — выполнена ли ЦЕЛЬ (квеста NPC или концовки) У КОНКРЕТНОГО игрока;
     soloTasksWin — RETROPOLIA SOLO / JOURNEY SOLO: победа = пройти ВСЕ задания карты;
     questWinCheck — вызывается после каждого изменения прогресса/ресурсов. */
  const questGoalsDone = (p: PlayerState, g: QuestGoal): boolean => {
    switch (g.kind) {
      case 'boss': return !!g.bossId && (s.qBossDown?.[p.id] ?? []).includes(g.bossId);
      case 'tasks': return (s.qDone?.[p.id] ?? []).length >= Math.max(1, Math.floor(g.count ?? 1));
      case 'coins': return (p.coinsLeft ?? 0) >= Math.max(1, Math.floor(g.count ?? 1));
      case 'hp': return (p.hp ?? RUBG_HP_MAX) >= Math.max(1, Math.floor(g.count ?? 1));
      case 'time': return p.secLeft >= Math.max(60, Math.floor(g.count ?? 60));
      case 'tries': return p.triesLeft >= Math.max(1, Math.floor(g.count ?? 1));
      default: return false;
    }
  };
  const soloTasksWin = (p: PlayerState): boolean => {
    if (map.mode !== 'classic1p' && map.mode !== 'journey1p') return false;
    if (s.mapless) return false; // безкартовый челлендж завершается своим счётчиком матчей
    const idxs: number[] = [];
    map.cells.forEach((c, i) => { if (c.type === 'task') idxs.push(i); });
    if (!idxs.length) return false;
    return idxs.every((i) => (s.qDone?.[p.id] ?? []).includes(i) || s.captured[i] === p.id);
  };
  const questWinCheck = () => {
    if (s.phase !== 'playing') return;
    if (isQuestMode(map.mode)) {
      const ends = map.endings ?? [];
      if (ends.length) {
        for (const p of alive()) {
          /* выбранная в диалоге концовка проверяется ПЕРВОЙ, остальные — по порядку карты */
          const chosen = Object.keys(s.qFlags?.[p.id] ?? {}).filter((f) => f.startsWith('ending:')).map((f) => f.slice(7));
          const order = chosen.length ? ends.filter((e) => chosen.includes(e.id)).concat(ends.filter((e) => !chosen.includes(e.id))) : ends;
          for (const e of order) {
            if (!e.goal || e.goal.kind === 'none') continue;
            if (questGoalsDone(p, e.goal)) {
              s.phase = 'over';
              s.winner = p.id;
              s.ending = { playerId: p.id, endingId: e.id };
              log(`🎬 КОНЦОВКА «${e.name}»! ${p.name} выполнил финальное условие — ПОБЕДА!`);
              return;
            }
          }
        }
      }
    }
    if ((map.mode === 'classic1p' || map.mode === 'journey1p') && !s.mapless) {
      for (const p of alive()) {
        if (soloTasksWin(p)) {
          s.phase = 'over';
          s.winner = p.id;
          log(`🏆 ${p.name} прошёл ВСЕ задания карты — ПОБЕДА!`);
          return;
        }
      }
    }
  };
  /* «/N» для логов провалов (QUEST: доп. условие поражения создателя карты) */
  const failsLimitText = (m: GameMap): string => (m.questDefeatFails && m.questDefeatFails > 0 ? `/${Math.floor(m.questDefeatFails)}` : '');
  /* Награда (квест NPC / выбор в диалоге): только включённые на карте ресурсы */
  const giveReward = (p: PlayerState, r: NpcReward, what: string): string => {
    const parts: string[] = [];
    const coins = Math.max(0, Math.floor(r.coins ?? 0));
    const min = Math.max(0, Math.floor(r.min ?? 0));
    const tries = Math.max(0, Math.floor(r.tries ?? 0));
    if (coins > 0 && map.startCoins !== undefined) { p.coinsLeft = Math.min(COINS_MAX, (p.coinsLeft ?? 0) + coins); parts.push(`+${coins} бронзы`); }
    if (min > 0) { p.secLeft += min * 60; parts.push(`+${min} мин`); }
    if (tries > 0) { p.triesLeft += tries; parts.push(`+${tries} поп.`); }
    if (parts.length) log(`🎁 ${p.name}: ${what} — ${parts.join(' ')}`);
    return parts.join(' ');
  };

  /* RUBG: масштаб времени ЗОНЫ из настройки карты (минуты и секунды в редакторе).
     Все фазы (ожидания и сжатия) растягиваются/сжимаются пропорционально, DPS не меняется.
     Минимум — 30 с, по умолчанию (карта без настройки) — 10 минут (RUBG_ZONE_DEFAULT_SEC). */
  const rubgZoneScale = (): number => {
    const total = Math.max(30, Math.floor(map.zoneSec ?? RUBG_ZONE_DEFAULT_SEC));
    return total / RUBG_ZONE_TOTAL;
  };

  /* RUBG: РАБОЧИЙ ПЛАН ФАЗ зоны в px поля. ЕДИНАЯ ФАЗА (map.zonePhase: пауза/сжатие/сужение
     в клетках) — приоритет: зона повторяет её, пока радиус не закроется (урон растёт по номеру фазы).
     Далее СТАРАЯ пофазная (map.zonePhases, карты до v0.41), иначе дефолтные фазы (mul-цепочка
     от r0), растянутые настройкой zoneSec. Вызывается ОДИН раз при появлении зоны — план
     сохраняется в состоянии зоны, дальше тик работает только с ним. */
  const rubgBuildPlan = (r0: number): RubgZonePhasePlan[] => {
    const dpsOf = (i: number): number => RUBG_ZONE_PHASES[Math.min(i, RUBG_ZONE_PHASES.length - 1)].dps;
    const one = map.zonePhase;
    if (one) {
      const wait = Math.max(0, Math.floor(one.wait || 0));
      const shrink = Math.max(5, Math.floor(one.shrink || 0));
      const distC = Math.max(0, Math.floor(one.dist || 0));
      const plan: RubgZonePhasePlan[] = [];
      let rr = r0;
      for (let i = 0; i < 40 && rr > 0.5; i++) {
        const distPx = distC > 0 ? Math.min(rr, distC * CELL_PX) : rr; // dist=0 — первое же сжатие закрывает карту
        plan.push({ wait, shrink, dps: dpsOf(i), distPx });
        rr -= distPx;
      }
      return plan.length ? plan : [{ wait, shrink, dps: dpsOf(0), distPx: r0 }];
    }
    const custom = map.zonePhases;
    if (custom && custom.length) {
      return custom.slice(0, 24).map((p, i) => ({
        wait: Math.max(0, Math.floor(p.wait || 0)),
        shrink: Math.max(5, Math.floor(p.shrink || 0)),
        dps: dpsOf(i),
        distPx: Math.max(0, Math.floor(p.dist || 0)) * CELL_PX,
      }));
    }
    const scale = rubgZoneScale();
    let rr = r0;
    return RUBG_ZONE_PHASES.map((p) => {
      const nr = rr * p.mul;
      const distPx = Math.max(0, rr - nr);
      rr = nr;
      return { wait: p.wait * scale, shrink: p.shrink * scale, dps: p.dps, distPx };
    });
  };

  /* RUBG: создать безопасную зону (первая фаза — ожидание сжатия). Вызывается, когда
     все выпрыгнули из самолёта (или фолбэком в тике хоста / при старте без самолёта). */
  const rubgStartZone = () => {
    if (!s.rubg || s.rubg.zone) return;
    const W = map.mw ?? map.cols * CELL_PX;
    const H = map.mh ?? map.rows * CELL_PX;
    const r0 = Math.hypot(W, H) / 2 * 0.75;
    const plan = rubgBuildPlan(r0); // фазы: авторские (пауза/сжатие/сужение в клетках) или дефолт
    const ph = plan[0];
    const waitSec = Math.round(ph.wait);
    const tr = Math.max(0, r0 - ph.distPx);
    const off = Math.max(0, r0 - tr) * 0.7;
    const now = Date.now();
    s.rubg.zone = {
      cx: W / 2, cy: H / 2, r: r0,
      sx: W / 2, sy: H / 2, sr: r0,
      tx: Math.max(0, Math.min(W, W / 2 + (Math.random() * 2 - 1) * off)),
      ty: Math.max(0, Math.min(H, H / 2 + (Math.random() * 2 - 1) * off)),
      tr,
      phase: 'wait', phaseStart: now, phaseEnd: now + waitSec * 1000,
      idx: 0, dps: ph.dps, lastTick: now, plan,
    };
    log(`⭕ Безопасная зона появилась: первое сжатие через ${rubgFmtZone(waitSec)}. Ищите задания и ЯЩИКИ с лутом!`);
  };

  /* RUBG: выдать предмет — на ПОЯС, если есть свободный слот (макс. 3), иначе в общий инвентарь */
  const rubgGiveItem = (p: PlayerState, kind: RubgItemKind): RubgItem => {
    const it = rubgMkItem(kind);
    const inv = p.items ?? (p.items = []);
    if (inv.filter((x) => x.belt).length < RUBG_BELT_SLOTS) it.belt = true;
    inv.push(it);
    return it;
  };

  /* RUBG: выдать ЛИЧНОЕ задание на ячейке i, если это возможно.
     ОДНА ЯЧЕЙКА — ОДИН ИГРОК: если кто-то УЖЕ играет задание на этой ячейке — отказ
     (announce: однократное пояснение в лог — вызывается при входе в ячейку;
     тик хоста вызывает без announce, чтобы не спамить).
     Возвращает true, если задание выдано. */
  const rubgTryJob = (p: PlayerState, i: number, announce: boolean): boolean => {
    const rg = s.rubg;
    if (!rg) return false;
    rg.jobs = rg.jobs ?? {};
    rg.stealth = rg.stealth ?? [];
    const c = map.cells[i];
    if (!c || c.type !== 'task') return false;
    if (rg.jobs[p.id]) return false; // уже играешь личное задание
    if (s.captured[i] === p.id) return false; // своя ячейка — отдых
    if (s.broken?.[i]) return false; // разбитая пуста
    const tk = cellTaskOf(s, map, i);
    if (!tk) return false; // задания нет
    const busyId = Object.entries(rg.jobs).find(([, j]) => j.cellIdx === i)?.[0];
    if (busyId) {
      if (announce) {
        const busyP = s.players.find((q) => q.id === busyId);
        log(`⏳ Ячейка №${i + 1} занята: ${busyP?.name ?? 'игрок'} уже играет это задание — ищите другое!`);
      }
      return false; // ОДНУ ячейку нельзя проходить вдвоём
    }
    rg.jobs[p.id] = { cellIdx: i, startedAt: Date.now() };
    rg.stealth = rg.stealth.filter((xid) => xid !== p.id); // вход в задание снимает стелс
    p.stealth = false;
    log(`🎮 ${p.name} играет задание «${tk.title.slice(0, 30)}» — ЛИЧНО, остальные не ждут`);
    return true;
  };

  /* RUBG: ПОСЛЕ ВЫСАДКИ — кто приземлился ПРЯМО в ячейку задания, сразу её открывает
     (как при входе ходьбой). Один раз при старте партии. ОДНА ячейка задания — ОДИН игрок.
     ЯЩИКИ С ЛУТОМ больше НЕ вскрываются проходом/приземлением — только взломом (отмычка/сила). */
  const rubgLandingJobs = () => {
    const rg = s.rubg;
    if (!rg) return;
    for (const pl of s.players) {
      if (!pl.alive || pl.spect) continue;
      if ((rg.jobs ?? {})[pl.id]) continue;
      const pp = playerPx(s, map, pl.id);
      if (!pp) continue;
      for (let i = 0; i < map.cells.length; i++) {
        const c = map.cells[i];
        if (!c || c.type !== 'task') continue;
        const r = cellRectOf(map, i);
        if (!r) continue;
        if (!(pp.x >= r.x && pp.x < r.x + r.w && pp.y >= r.y && pp.y < r.y + r.h)) continue;
        pl.pos = i;
        if (!s.revealed.includes(i)) s.revealed.push(i);
        rubgTryJob(pl, i, true);
        break;
      }
    }
  };

  const endTurnNow = () => {
    if (s.phase !== 'playing') return;
    s.turnNo = (s.turnNo ?? 1) + 1; // номер хода партии (для автосейвов)
    /* РАЗБИТЫЕ ЯЧЕЙКИ: тик восстановления — каждый ХОД ЛЮБОГО игрока.
       Без нового задания ячейка оживает через 2 хода (задание карты возвращается),
       с заданием победителя — через 3 хода (его задание вступает в силу). */
    for (const key of Object.keys(s.broken ?? {})) {
      const idx = Number(key);
      const br = s.broken![idx];
      if (!br) continue;
      br.left = (br.left ?? 0) - 1;
      if (br.left <= 0) {
        if (br.task) {
          s.sessionTasks[idx] = br.task;
          const nm = s.players.find((x) => x.id === br.by)?.name ?? '';
          log(`🧱 Ячейка №${idx + 1} восстановилась — задание ${nm} вступило в силу`);
        } else {
          log(`🧱 Ячейка №${idx + 1} восстановилась сама`);
        }
        delete s.broken![idx];
      }
    }
    /* JOURNEY/QUEST/RUBG: очереди ходов нет — после задания фишки снова ходят одновременно */
    if (isJourneyLike(map.mode)) return;
    nextTurn();
    /* SKILL CHALLENGE: хост выдержал лимит ходов с ресурсами — челлендж пройден */
    if (map.mode === 'skill' && s.phase === 'playing' && (s.turnNo ?? 1) > SKILL_TURNS) {
      const host = s.players.find((p) => p.isHost);
      s.phase = 'over';
      if (host && host.alive && !host.spect) {
        s.winner = host.id;
        log(`🏆 SKILL CHALLENGE ПРОЙДЕН! ${host.name} выдержал ${SKILL_TURNS} ходов — ресурсы на месте`);
      } else {
        log(`⏱ ${SKILL_TURNS} ходов истекли`);
      }
    }
  };

  // Завершение квиза верным ответом: в обычном режиме и «коте в мешке»
  // в pending ровно один ответ — его автор и получает бонус. sentAt оставлен
  // как запасной критерий на случай нескольких ответов (старые сессии).
  const settleQuiz = (
    q: NonNullable<GameSession['quiz']>,
    pending: { id: string; name: string; sentAt: number }[],
  ) => {
    if (q.resolved) return;
    if (pending.length > 0) {
      const winner = pending.reduce((best, x) => (x.sentAt < best.sentAt ? x : best), pending[0]);
      const w = s.players.find((x) => x.id === winner.id);
      if (map.startCoins !== undefined) {
        // МОНЕТЫ активны: бонус победителю квиза монетами
        const wc = Math.max(0, Math.floor(map.quizWinCoins ?? 0));
        if (w) w.coinsLeft = Math.min(COINS_MAX, (w.coinsLeft ?? 0) + wc);
        q.resolved = true;
        q.result = {
          correct: true, deltaMin: 0, deltaTries: 0, targetName: winner.name, reason: 'correct',
        };
        log(`✔ ${winner.name}: верный ответ! +${wc} бронзы — капитал ${coinsStr(w?.coinsLeft ?? 0)}`);
      } else {
        const kind = map.resMode === 'time' ? 'time' : map.resMode === 'tries' ? 'tries' : Math.random() < 0.5 ? 'time' : 'tries';
        if (w) {
          if (kind === 'time') w.secLeft += 300;
          else w.triesLeft += 5;
        }
        q.resolved = true;
        q.result = {
          correct: true,
          deltaMin: kind === 'time' ? 5 : 0,
          deltaTries: kind === 'time' ? 0 : 5,
          targetName: winner.name,
          reason: 'correct',
        };
        log(`✔ ${winner.name}: верный ответ! +5 ${kind === 'time' ? 'мин' : 'попыток'}`);
      }
    } else {
      q.resolved = true;
      q.result = { correct: false, deltaMin: 0, deltaTries: 0, targetName: '', reason: 'allWrong' };
      log('Квиз: ошиблись все — бонус никто не получает');
    }
  };

  /* ---------- FX: разовые анимации-спектакль (победа/поражение фишки, реакции боссов) ----------
     Сценарий «последствий» (видят все): 1 секунда тишины после задания — потом BOTH
     клипа (фишка + босс) с их звуками; в момент старта клипов ячейка РАЗБИВАЕТСЯ
     (fxBreak) с коротким разлётом осколков; после клипов — 2 секунды «послевкусия»,
     и только потом окно выбора/передача хода. */
  const FX_PAUSE_MS = 1000; // тишина после закрытия задания до старта анимаций
  const FX_HOLD_MS = 2000;  // «послевкусие» после анимаций до окна выбора / передачи хода
  const gatingFx = (): boolean => (s.fxs ?? []).some((f) => f.gate);
  const clipMs = (clip?: { fps: number; frames: string[] } | null): number => {
    if (!clip || !clip.frames.length) return 0;
    const fps = Math.max(1, Math.min(24, clip.fps || 6));
    return Math.max(400, Math.min(12000, Math.round((clip.frames.length / fps) * 1000)));
  };
  const tokAnimOf = (p: PlayerState) => {
    const tk = p.tokenKey ? (map.mapTokens ?? []).find((x) => x.id === p.tokenKey) : null;
    return tk?.anim ?? null;
  };
  const pushFx = (fx: Omit<GameFx, 'id' | 'ts'>) => {
    s.fxs = [...(s.fxs ?? []).slice(-8), { ...fx, id: 'fx' + Math.random().toString(36).slice(2, 9), ts: Date.now() }];
  };
  /* Реакции боссов: игрок в радиусе (r) босса победил/проиграл задание —
     босс ОДИН раз проигрывает клип win/lose со своим звуком. Побеждённый
     (замеревший) босс больше не реагирует. delay — пауза до старта реакции.
     Возвращает максимальную длительность запущенных клипов (0 — никто не отреагировал). */
  const triggerBossFx = (cellIdx: number, success: boolean, delay = 0): number => {
    const bosses = map.bosses ?? [];
    if (!bosses.length) return 0;
    const blib = new Map((map.bossLib ?? []).map((b) => [b.id, b]));
    const p = current();
    const jp = map.mode === 'journey' ? (s.journeyPos?.[p.id] ?? null) : null;
    const pc = cellCenter(map, p.pos);
    const px = jp ? jp.x : pc.x;
    const py = jp ? jp.y : pc.y;
    let maxMs = 0;
    for (const b of bosses) {
      if (s.bossDown?.[b.id]) continue;
      const def = blib.get(b.bid);
      if (!def) continue;
      if (!b.r || b.r <= 0) continue; // радиус не задан — босс молчит и не реагирует
      if (Math.hypot(px - b.x, py - b.y) > b.r) continue;
      const clip = success ? def.win : def.lose;
      const ms = clipMs(clip);
      if (!ms) continue;
      pushFx({ kind: success ? 'bossWin' : 'bossLose', player: p.id, cellIdx, bossId: b.id, ms, after: 'none', delay });
      maxMs = Math.max(maxMs, ms);
      log(success ? `👹 Босс «${def.name}» получает удар — повержен!` : `👹 Босс «${def.name}» отражает атаку — игрок пал!`);
    }
    return maxMs;
  };

  const finishChallenge = (success: boolean, spentSec: number, spentTries: number) => {
    const ch = s.challenge;
    if (!ch) return;
    const p = current();
    const cellNo = ch.cellIdx + 1;
    /* SKILL CHALLENGE и БЕЗКАРТОВАЯ ИГРА: ячейка «сыграна» (пройдена или пропущена) —
       задание на ней больше не открывается */
    if ((map.mode === 'skill' || map.mapless) && !(s.skillDone ?? []).includes(ch.cellIdx)) {
      s.skillDone = [...(s.skillDone ?? []), ch.cellIdx];
    }
    /* БЕЗ КАРТЫ: матч сыгран — счётчик двигается; все матчи — флаг победы,
       партию завершит хост действием maplessFinish (после анимаций) */
    if (s.mapless) {
      s.mapless.done = Math.min(s.mapless.total, (s.mapless.done ?? 0) + 1);
      if (s.mapless.done >= s.mapless.total) s.mapless.over = true;
      log(`🎮 Матч ${s.mapless.done} из ${s.mapless.total} ${success ? 'ПРОЙДЕН' : 'закончен'} — осталось ${Math.max(0, s.mapless.total - s.mapless.done)}`);
    }
    p.secLeft = Math.max(0, p.secLeft - spentSec);
    p.triesLeft = Math.max(0, p.triesLeft - spentTries);
    /* МОНЕТЫ (если включены на карте): победа — награда, пропуск/проигрыш — цена.
       Выплаты монетами идут ПОВЕРХ обычной цены времени/попыток. */
    if (map.startCoins !== undefined) {
      const winC = Math.max(0, Math.floor(map.taskWinCoins ?? 0));
      const skipC = Math.max(0, Math.floor(map.skipCoins ?? SKIP_COINS_DEFAULT));
      if (success && winC > 0) {
        p.coinsLeft = Math.min(COINS_MAX, (p.coinsLeft ?? 0) + winC);
        log(`🪙 Награда монетами: +${winC} бронзы — капитал ${coinsStr(p.coinsLeft)}`);
      }
      if (!success && skipC > 0) {
        p.coinsLeft = Math.max(0, (p.coinsLeft ?? 0) - skipC);
        log(`🪙 Плата за пропуск: −${skipC} бронзы — капитал ${coinsStr(p.coinsLeft)}`);
      }
    }
    /* РЕСУРС «ПОЛОСКА HP» (карты с выбором «HP»; RUBG не попадает — у него личные задания):
       победа +10% HP, поражение/пропуск −5% HP (плата по итогам, как в RUBG) */
    if (map.resMode === 'hp' && map.mode !== 'rubg') {
      if (success) {
        p.hp = Math.min(RUBG_HP_MAX, (p.hp ?? RUBG_HP_MAX) + RUBG_WIN_HP);
        log(`❤️ +${RUBG_WIN_HP}% HP — полоска ${Math.round(p.hp)}%`);
      } else {
        p.hp = Math.max(0, (p.hp ?? RUBG_HP_MAX) - RUBG_LOSE_HP);
        log(`💔 −${RUBG_LOSE_HP}% HP — полоска ${Math.round(p.hp)}%`);
      }
    }
    /* СВОЙ ЧЕЛЛЕНДЖ — штраф за проигрыш и награда за победу (задаётся мастером
       «Создать челлендж» и применяется в редакторе карт): минус ресурсы при
       поражении, плюс ресурсы при победе — ПОМИМО обычной цены задания. */
    const loseMin = Math.max(0, Math.floor(map.loseMin ?? 0));
    const loseTries = Math.max(0, Math.floor(map.loseTries ?? 0));
    const winMin = Math.max(0, Math.floor(map.winMin ?? 0));
    const winTries = Math.max(0, Math.floor(map.winTries ?? 0));
    if (!success && (loseMin > 0 || loseTries > 0)) {
      p.secLeft = Math.max(0, p.secLeft - loseMin * 60);
      p.triesLeft = Math.max(0, p.triesLeft - loseTries);
      log(`💢 Штраф челленджа: −${loseMin} мин / −${loseTries} поп.`);
    }
    if (success && (winMin > 0 || winTries > 0)) {
      p.secLeft += winMin * 60;
      p.triesLeft += winTries;
      log(`🎁 Награда челленджа: +${winMin} мин / +${winTries} поп.`);
    }
    const ownerId = s.captured[ch.cellIdx];
    const owner = ownerId && ownerId !== p.id ? s.players.find((x) => x.id === ownerId && x.alive) : undefined;
    if (owner && (spentSec > 0 || spentTries > 0)) {
      owner.secLeft += spentSec;
      owner.triesLeft += spentTries;
      log(`⚡ Ресурсы (${spentSec ? `${Math.round(spentSec / 60)} мин` : ''}${spentTries ? ` ${spentTries} поп.` : ''}) ушли хозяину ${owner.name}`);
    }
    /* пакости-правила на задании: «Без очков» и «Половина победы» */
    const t0 = cellTaskOf(s, map, ch.cellIdx);
    const noReward = t0?.chaos === 'noReward';
    const halfWin = t0?.chaos === 'halfWin';
    if (success) {
      const winMs = clipMs(tokAnimOf(p)?.win);
      if (noReward) {
        log(`😈 Без очков: ${p.name} прошёл задание, но ячейка не захвачена и награды нет`);
      } else if (halfWin) {
        const backSec = Math.floor(spentSec / 2);
        const backTries = Math.floor(spentTries / 2);
        if (backSec > 0) p.secLeft += backSec;
        if (backTries > 0) p.triesLeft += backTries;
        const parts = [backSec ? `${Math.round(backSec / 60)} мин` : '', backTries ? `${backTries} поп.` : ''].filter(Boolean).join(' + ');
        log(`😈 Половина победы: ${p.name} прошёл задание, ячейка не захвачена, возврат ${parts || '0'}`);
      } else {
        s.captured[ch.cellIdx] = p.id;
        /* ПОБЕДА — спектакль по таймингу пользователя: сначала 1 секунда тишины
           (окно выбора НЕ показываем), затем оба клипа (5-я анимация фишки + реакции
           боссов) со звуками; В МОМЕНТ старта клипов фишка РАЗБИВАЕТ ячейку (fxBreak —
           короткий разлёт осколков); после клипов 2 секунды «послевкусия» — и только
           потом открывается окно «играть дальше / создать задание» (awaitPost уже
           выставлен, но окно ждёт снятия блокирующего fx). */
        s.awaitPost = true;
        log(`🏆 ${p.name} побеждает в задании №${cellNo}!`);
      }
      /* Общий спектакль победы: 1 с тишины → клипы фишки и боссов → 2 с «послевкусия».
         Без захвата (noReward/halfWin) — то же шоу, но окно и разбитие не положены:
         после спектакля ход уйдёт следующему (after:'endTurn'). */
      const bossMs = triggerBossFx(ch.cellIdx, true, FX_PAUSE_MS);
      const seqMs = Math.max(winMs, bossMs) + FX_HOLD_MS;
      pushFx({
        kind: 'tokenWin', player: p.id, cellIdx: ch.cellIdx, ms: seqMs, gate: true,
        after: s.awaitPost ? 'post' : 'endTurn', delay: FX_PAUSE_MS,
      });
      /* радость за прохождение задания (если назначена и не отменена «Без очков») */
      const joyId = t0?.joy;
      if (joyId && !noReward) {
        const meta = JOY_LIST.find((j) => j.id === joyId);
        if (meta) {
          (p.inventory ?? (p.inventory = [])).push(mkJoyCard(joyId as JoyId));
          log(`🎉 ${p.name} получает радость «${meta.name}»`);
        }
      }
    } else {
      log(`⏭ ${p.name} пропускает задание на ячейке №${cellNo}`);
      /* ПОРАЖЕНИЕ — спектакль по таймингу пользователя: 1 секунда камера НЕ уходит
           (ход ещё у проигравшего), затем оба клипа проигрыша (6-я анимация фишки +
           реакции боссов) со звуками, ячейка остаётся как была, ещё 2 секунды — и
           только потом ход уходит следующему игроку. */
      const bossMsLose = triggerBossFx(ch.cellIdx, false, FX_PAUSE_MS);
      const loseMs = clipMs(tokAnimOf(p)?.lose);
      const seqMsLose = Math.max(loseMs, bossMsLose) + FX_HOLD_MS;
      pushFx({ kind: 'tokenLose', player: p.id, cellIdx: ch.cellIdx, ms: seqMsLose, gate: true, after: 'endTurn', delay: FX_PAUSE_MS });
    }
    s.challenge = null;
    if (!success) {
      if (!gatingFx()) endTurnNow(); // есть анимация поражения — ход уйдёт после неё (fxDone)
    } else if (!s.awaitPost && !gatingFx()) {
      endTurnNow(); // «Без очков»/«Половина победы»: права продолжить ход нет
    }
  };

  /* БЕЗ КАРТЫ: индекс следующего неигранного матча (ячейка задания вне skillDone) */
  const maplessNextIdx = (): number => {
    const done = s.skillDone ?? [];
    return map.cells.findIndex((c, i) => c.type === 'task' && !done.includes(i) && !s.broken?.[i]);
  };

  const othersCount = () => alive().length - 1;

  const challengeSuccess = () => {
    const ch = s.challenge!;
    const nowMs = Date.now();
    const running = ch.mode === 'time' && ch.started && !ch.paused && ch.startedAt > 0;
    const totalMs = ch.accMs + (running ? nowMs - ch.startedAt : 0);
    const spentSec = ch.mode === 'time' ? Math.ceil(totalMs / 60000) * 60 : 0;
    const spentTries = ch.mode === 'tries' ? ch.loads : 0;
    finishChallenge(true, spentSec, spentTries);
    checkElim();
  };

  const resolveLanding = () => {
    const p = current();
    const cell = map.cells[p.pos];
    if (!cell) { endTurnNow(); return; }
    /* SKILL CHALLENGE — каждый ход с заданием: встав на ячейку, которую уже
       ПРОШЁЛ или ПРОПУСТИЛ (или на разбитую — она пуста), фишка АВТОМАТИЧЕСКИ
       едет по дороге к следующей ячейке с неигранным заданием — и это видно
       (ход анимируется, как обычное движение). Стрелка-прыжок на остановке
       срабатывает как обычно. Если неигранных не осталось — передышка. */
    const skillAutoNext = (): boolean => {
      if (map.mode !== 'skill') return false;
      const doneCells = s.skillDone ?? [];
      if (!doneCells.includes(p.pos) && !s.broken?.[p.pos]) return false;
      const fromName = posName(p.pos);
      const isFree = (idx: number) => {
        const cc = map.cells[idx];
        return !!cc && cc.type === 'task' && !doneCells.includes(idx) && !s.broken?.[idx] && !!cellTaskOf(s, map, idx);
      };
      const path: number[] = [];
      let c = p.pos;
      const h0 = hopTargetOf(map, c); // прыжок-стрелка срабатывает на ОСТАНОВКЕ — мы остановились
      if (h0 !== c) { path.push(h0); log(`↳ переход по стрелке → ${posName(h0)}`); c = h0; }
      if (!isFree(c)) {
        for (let g = 0; g < map.cells.length + 2; g++) {
          c = stepNext(map, c);
          if (c === p.pos || (path.length > 0 && path[path.length - 1] === c)) break; // обошли круг — неигранных нет
          path.push(c);
          if (isFree(c)) break;
        }
      }
      if (isFree(c)) {
        if (!path.length || path[path.length - 1] !== c) path.push(c);
        const fh = hopTargetOf(map, c);
        if (fh !== c && fh !== path[path.length - 1]) { path.push(fh); log(`↳ переход по стрелке → ${posName(fh)}`); }
        s.moving = { player: p.id, path, ts: Date.now() };
        p.pos = path[path.length - 1];
        log(`⏭ ${p.name}: ${fromName} уже сыграна — фишка сама едет к следующему заданию (${posName(p.pos)})`);
        return true;
      }
      log(`⏭ Все задания уже сыграны — ${fromName} просто передышка`);
      s.notice = { text: 'Все задания карты уже пройдены или пропущены — передышка.', ts: Date.now() };
      endTurnNow();
      return true;
    };
    if (skillAutoNext()) return;
    /* РАЗБИТАЯ ЯЧЕЙКА считается ПУСТОЙ: задание не открывается, карточек и квиза нет —
       передышка, пока не восстановится (хозяин — победитель, он уже назначен). */
    if (s.broken?.[p.pos]) {
      log(`💥 Ячейка ${posName(p.pos)} разбита — передышка, пока идёт восстановление`);
      s.notice = { text: `Ячейка ${posName(p.pos)} разбита и считается пустой — здесь ничего не происходит, пока она не восстановится.`, ts: Date.now() };
      endTurnNow();
      return;
    }
    if (cell.type === 'bonus' || cell.type === 'trap') {
      const deck = cell.type === 'bonus' ? map.bonusCards : map.trapCards;
      if (deck.length === 0) {
        log(`Ячейка ${posName(p.pos)} пуста — передышка`);
        s.notice = { text: `Ячейка ${posName(p.pos)} (${cell.type === 'bonus' ? 'бонус' : 'ловушка'}) без карточек — передышка. Добавьте карточки в редакторе заданий.`, ts: Date.now() };
        endTurnNow();
        return;
      }
      const card = deck[Math.floor(Math.random() * deck.length)];
      applyCard(p, card);
      s.pendingCard = { card, player: p.id, done: false };
      log(`${cell.type === 'bonus' ? '🌟 БОНУС' : '☠ ЛОВУШКА'}: «${card.name}»`);
      return;
    }
    if (cell.type === 'quiz') {
      const all = map.quizzes ?? [];
      if (all.length === 0) {
        log(`Ячейка ${posName(p.pos)} — квиз, но на карте нет вопросов. Передышка`);
        s.notice = { text: `На карте нет вопросов для квиза — передышка. Создайте квизы в редакторе.`, ts: Date.now() };
        endTurnNow();
        return;
      }
      // вопросы, уже прозвучавшие в этой партии, не повторяются
      const pool = all.filter((qz) => !(s.usedQuizzes ?? []).includes(qz.id));
      if (pool.length === 0) {
        log(`Все квизы карты уже прозвучали — передышка`);
        s.notice = { text: `Все квизы этой карты уже прозвучали — передышка.`, ts: Date.now() };
        endTurnNow();
        return;
      }
      const q = pool[Math.floor(Math.random() * pool.length)];
      s.usedQuizzes = [...(s.usedQuizzes ?? []), q.id];
      if (q.type === 'mystery') {
        // «кот в мешке»: игрок сам выбирает, кому передать вопрос
        s.quiz = { quizId: q.id, askerId: p.id, targetId: '', startedAt: 0, resolved: false };
        log(`🎁 ${p.name} встал на «кота в мешке» (ячейка ${posName(p.pos)}) — выбирает, кому передать вопрос`);
      } else {
        // гонка: вопрос видят все, отвечает кто быстрее
        s.quiz = { quizId: q.id, askerId: p.id, targetId: p.id, startedAt: Date.now(), resolved: false };
        log(`🎲 КВИЗ (ячейка ${posName(p.pos)})! Вопрос видят все — кто первым ответит, тот и забирает`);
      }
      return;
    }
      if (cell.type === 'start') {
        log(`${p.name} на стартовой ячейке — отдых`);
        endTurnNow();
        return;
    }
    if (cell.type === 'rest') {
      // пустая клетка-передышка: задание/карточка/квиз не нужны вообще
      log(`${p.name} отдыхает на ячейке ${posName(p.pos)} — передышка`);
      s.notice = { text: `Передышка: ячейка ${posName(p.pos)} пустая — здесь ничего не происходит.`, ts: Date.now() };
      endTurnNow();
      return;
    }
    const task = cellTaskOf(s, map, p.pos);
    if (!task) {
      log(`Ячейка ${posName(p.pos)} без задания — передышка`);
      s.notice = { text: `Ячейка ${posName(p.pos)} без задания — передышка. Назначьте ей ром и сохранение в редакторе заданий.`, ts: Date.now() };
      endTurnNow();
      return;
    }
    if (s.captured[p.pos] === p.id) {
      log(`${p.name} на своей ячейке ${posName(p.pos)} — отдых`);
      endTurnNow();
      return;
    }
    s.notice = null;
    s.challenge = {
      cellIdx: p.pos, mode: null, started: false, paused: false, startedAt: 0, accMs: 0, loads: 0, reloadId: 0,
      status: 'choose', approvals: [], violations: [], lowStart: false,
    };
    /* ТОЛЬКО МОНЕТЫ: выбора ресурса нет — задание сразу готово к запуску (платёж по итогам) */
    if (map.coinsOnly && map.startCoins !== undefined) {
      s.challenge.mode = 'coins';
      s.challenge.status = 'ready';
    } else if (map.resMode === 'hp') {
      /* РЕСУРС «ПОЛОСКА HP»: выбора нет — задание сразу готово (плата по итогам: +10% победа / −5% поражение) */
      s.challenge.mode = 'hp';
      s.challenge.status = 'ready';
    } else if (map.resMode === 'time' || map.resMode === 'tries') {
      /* ОДИН РЕСУРС (мастер челленджа): выбора нет — задание сразу готово */
      s.challenge.mode = map.resMode;
      s.challenge.status = 'ready';
    }
    const owner = s.captured[p.pos] ? s.players.find((x) => x.id === s.captured[p.pos]) : null;
    log(`🎯 ${p.name}: задание на ячейке ${posName(p.pos)}${owner ? ` (хозяин ${owner.name})` : ''}`);
    /* пакость «Один кубик»: следующий бросок вставшего — только один кубик */
    if (task.chaos === 'oneDie' && s.captured[p.pos] !== p.id && !p.oneDie) {
      p.oneDie = true;
      log(`😈 Один кубик: следующий бросок ${p.name} — только один кубик`);
    }
  };

  /* имя ячейки для логов: №N или «на круге» (ячейка без номера) */
  const posName = (idx: number): string => {
    const c = map.cells[idx];
    return c ? (c.nonumber || c.n === 0 ? 'на круге' : `№${c.n}`) : `№${idx + 1}`;
  };

  const applyCard = (p: PlayerState, card: CardDef, questSafe = false) => {
    const e = card.effect;
    /* QUEST: игра индивидуальная — эффекты переноски/очерёдности не имеют смысла
       (они остановили бы всех). Ресурсные и складные эффекты работают как обычно. */
    if (questSafe && ['move', 'teleport', 'wrongway', 'jail', 'extraTurn', 'skipTurn', 'playerExtra', 'playerSkip', 'diePlus'].includes(e.type)) {
      log(`🎴 «${card.name}»: эффект не действует — в QUEST играют индивидуально`);
      return;
    }
    const N = map.cells.length;
    const norm = (v: number) => ((v % N) + N) % N;
    const stepsTo = (from: number, to: number, dir: 1 | -1) => {
      const out: number[] = [];
      let c = from;
      for (let g = 0; g < N + 2 && c !== to; g++) {
        c = norm(c + dir);
        out.push(c);
      }
      return out.length ? out : [to];
    };
    switch (e.type) {
      case 'move': {
        // шагаем по маршруту (безномерные клетки перескакиваются), а ОСТАНОВКА
        // на ячейке со стрелкой перехода — прыжок по ней (вход в круг/штраф)
        const dir = e.value >= 0 ? 1 : -1;
        const path: number[] = [];
        let c = p.pos;
        for (let g = 0; g < Math.abs(e.value); g++) {
          c = dir === 1 ? stepNext(map, c) : stepPrev(map, c);
          path.push(c);
        }
        if (!path.length) path.push(p.pos);
        const mh = hopTargetOf(map, path[path.length - 1]);
        if (mh !== path[path.length - 1]) { path.push(mh); log(`${p.name}: переход по стрелке → ${posName(mh)}`); }
        s.moving = { player: p.id, path, ts: Date.now() };
        p.pos = path[path.length - 1];
        log(`${p.name} → ячейка ${posName(p.pos)}`);
        break;
      }
      case 'teleport': {
        // переход на ячейку с НОМЕРОМ N (номер = тот, что нарисован на карте);
        // если на ячейке стрелка перехода — фишка сразу прыгает по ней
        const byN = map.cells.findIndex((cc) => cc.n === e.value);
        const to = byN >= 0 ? byN : Math.min(Math.max(1, e.value), N) - 1;
        const th = hopTargetOf(map, to);
        const path = th !== to ? [to, th] : [to];
        if (th !== to) log(`${p.name}: переход по стрелке → ${posName(th)}`);
        s.moving = { player: p.id, path, ts: Date.now() };
        p.pos = path[path.length - 1];
        log(`${p.name} → ячейка ${posName(p.pos)}`);
        break;
      }
      case 'jail':
        p.skipTurns += Math.max(1, e.value);
        log(`${p.name}: отпуск — пропуск ${Math.max(1, e.value)} х.`);
        break;
      case 'wrongway': {
        // ищем ближайшую спец-ячейку ВПЕРЁД ПО ОСНОВНОМУ ПУТИ (закоулки перескакиваем)
        let to = -1;
        let c = p.pos;
        for (let st = 1; st <= N; st++) {
          c = stepNext(map, c);
          const cc = map.cells[c];
          if (cc && (cc.type === 'trap' || cc.type === 'bonus')) { to = c; break; }
        }
        if (to < 0) {
          to = p.pos;
          for (let st = 0; st < 3; st++) to = prevCellOf(map, to); // ~назад на 3
        }
        const wPath = stepsTo(p.pos, to, 1);
        const wh = hopTargetOf(map, wPath[wPath.length - 1]);
        if (wh !== wPath[wPath.length - 1]) wPath.push(wh);
        s.moving = { player: p.id, path: wPath, ts: Date.now() };
        p.pos = wPath[wPath.length - 1];
        log(`${p.name}: поворот не туда → ячейка ${posName(p.pos)}`);
        break;
      }
      case 'extraTurn': p.extraTurn = true; log(`${p.name}: доп. ход!`); break;
      case 'skipTurn': p.skipTurns += 1; log(`${p.name}: пропуск хода`); break;
      case 'playerExtra': {
        const t = s.players[(e.target - 1 + s.players.length) % s.players.length];
        t.extraTurn = true;
        log(`${t.name}: доп. ход (от карты)`);
        break;
      }
      case 'playerSkip': {
        const t = s.players[(e.target - 1 + s.players.length) % s.players.length];
        t.skipTurns += 1;
        log(`${t.name}: пропуск хода (от карты)`);
        break;
      }
      case 'addMin': p.secLeft += e.value * 60; log(`${p.name}: +${e.value} мин`); break;
      case 'subMin': p.secLeft = Math.max(0, p.secLeft - e.value * 60); log(`${p.name}: −${e.value} мин`); break;
      case 'addTries': p.triesLeft += e.value; log(`${p.name}: +${e.value} попыток`); break;
      case 'subTries': p.triesLeft = Math.max(0, p.triesLeft - e.value); log(`${p.name}: −${e.value} попыток`); break;
      case 'toInventory': {
        // карточка не срабатывает сразу — игрок забирает её в инвентарь:
        // пакость клеится к своему будущему заданию, обычная — применяется в удобный момент
        (p.inventory ?? (p.inventory = [])).push(card);
        log(`🎒 ${p.name} забирает карточку «${card.name}» в инвентарь`);
        break;
      }
      case 'diePlus':
        p.dicePlus = true;
        log(`🎲 ${p.name}: следующий бросок — сразу 3 кубика!`);
        break;
      case 'addMinTries':
        p.secLeft += e.value * 60;
        p.triesLeft += e.value;
        log(`🍀 ${p.name}: +${e.value} мин и +${e.value} попыток`);
        break;
      case 'freeSkip':
        p.freeSkip = true;
        log(`🎫 ${p.name}: пропуск любого задания без платы наготове`);
        break;
      case 'immuneSega':
        (p.inventory ?? (p.inventory = [])).push(mkJoyCard('joy-immuneSega'));
        log(`🛡 ${p.name} получает «Иммунитет к SEGA»`);
        break;
      case 'immuneNes':
        (p.inventory ?? (p.inventory = [])).push(mkJoyCard('joy-immuneNes'));
        log(`🛡 ${p.name} получает «Иммунитет к NES»`);
        break;
    }
  };

  /* ---------- торги карточками и ячейками ---------- */
  const priceStr = (m: number, t: number): string =>
    m > 0 && t > 0 ? `${m} мин + ${t} поп.` : m > 0 ? `${m} мин` : `${t} поп.`;
  const openTradeOfCard = (cardId: string): TradeOffer | undefined =>
    (s.trades ?? []).find((x) => (x.status === 'pending' || x.status === 'countered') && x.cardId === cardId);
  const openTradeOfCell = (idx: number): TradeOffer | undefined =>
    (s.trades ?? []).find((x) => (x.status === 'pending' || x.status === 'countered') && x.cellIdx === idx);
  const execTrade = (o: TradeOffer, min: number, tries: number): boolean => {
    const seller = s.players.find((x) => x.id === o.from);
    const buyer = s.players.find((x) => x.id === o.to);
    if (!seller || !buyer || !seller.alive || !buyer.alive) { o.status = 'declined'; return false; }
    if (buyer.secLeft < min * 60 || buyer.triesLeft < tries) {
      o.status = 'declined';
      log(`✖ Сделка сорвалась: у ${buyer.name} не хватает ресурсов на оплату`);
      return false;
    }
    if (o.cellIdx !== undefined) {
      // торги ячейкой: меняется только хозяин — задание остаётся прежним,
      // покупать задание заново не нужно
      if (s.captured[o.cellIdx] !== o.from) { o.status = 'declined'; return false; }
      buyer.secLeft -= min * 60;
      buyer.triesLeft -= tries;
      seller.secLeft += min * 60;
      seller.triesLeft += tries;
      s.captured[o.cellIdx] = buyer.id;
      o.status = 'done';
      log(`🤝 ${buyer.name} покупает у ${seller.name} ячейку №${o.cellIdx + 1} за ${priceStr(min, tries)}`);
      checkElim();
      return true;
    }
    const inv = seller.inventory ?? (seller.inventory = []);
    const ci = inv.findIndex((c) => c.id === o.cardId);
    if (ci < 0) { o.status = 'declined'; return false; }
    const [card] = inv.splice(ci, 1);
    (buyer.inventory ?? (buyer.inventory = [])).push(card);
    buyer.secLeft -= min * 60;
    buyer.triesLeft -= tries;
    seller.secLeft += min * 60;
    seller.triesLeft += tries;
    o.status = 'done';
    log(`🤝 ${buyer.name} покупает «${card.name}» у ${seller.name} за ${priceStr(min, tries)}`);
    checkElim();
    return true;
  };

  /* ---------- Страховка: протухшие fx снимаем сами (сообщение fxDone потерялось,
     игрок закрыл вкладку и т.п.). Блокирующие — с исполнением отложенного действия:
     если разбитие (fxBreak) не дошло — разбиваем сами, потом окно/передача хода. ---------- */
  const now0 = Date.now();
  for (const fx of s.fxs ?? []) {
    const total = (fx.delay ?? 0) + fx.ms;
    const expired = fx.gate ? now0 - fx.ts > total + 2500 : now0 - fx.ts > total + 3000;
    if (!expired) continue;
    if (fx.gate && fx.after === 'post' && !s.broken?.[fx.cellIdx]) {
      s.broken = s.broken ?? {};
      s.broken[fx.cellIdx] = { by: fx.player, left: 2, at: Date.now() };
      const wn = s.players.find((x) => x.id === fx.player)?.name ?? '';
      log(`💥 ${wn} побеждает и РАЗБИВАЕТ ячейку №${fx.cellIdx + 1}!`);
    }
    s.fxs = (s.fxs ?? []).filter((f) => f.id !== fx.id);
    if (fx.gate && fx.after === 'endTurn') endTurnNow();
  }

  switch (a.t) {
    case 'hello': {
      /* SKILL CHALLENGE и одиночный JOURNEY: зрители могут подключаться и ВО ВРЕМЯ партии —
        они добавляются как spect (ходов не получают, смотрят поле и трансляцию) */
      const spectJoin = isSoloMode(map.mode) && (s.phase === 'playing' || s.phase === 'rollOff');
      if (s.phase !== 'lobby' && !spectJoin) return s0;
      if (s.players.some((p) => p.id === a.id)) return s0;
      if (!spectJoin && s.players.length >= 4) return s0;
      if (spectJoin && s.players.length >= 8) return s0;
      const np = mkPlayer(a.id, a.name, s.players.length % 4, false);
      if (spectJoin) { np.spect = true; np.ready = true; }
      s.players.push(np);
      log(spectJoin ? `👁 ${a.name.toUpperCase()} подключается зрителем` : `${a.name.toUpperCase()} подключается`);
      break;
    }
    case 'ready': {
      const p = actor();
      if (p && s.phase === 'lobby') p.ready = a.ready;
      break;
    }
    case 'kick': {
      if (s.phase === 'lobby') {
        s.players = s.players.filter((p) => p.id !== aid || p.isHost);
        log(`Игрок удалён из лобби`);
      }
      break;
    }
    case 'start': {
      if (s.phase !== 'lobby') break;
      /* Одиночные режимы (SKILL CHALLENGE, JOURNEY-на-одного): хост может начать и в
        одиночку — остальные в лобби станут зрителями; в остальных режимах партия
        на двоих и более */
      const soloMode = isSoloMode(map.mode);
      if (s.players.length < 2 && !soloMode) break;
      /* Стартовые ресурсы — из карты (одинаковые для всех игроков).
         Старые карты без настроек получают прежние значения (60 мин / 60 попыток).
         SKILL CHALLENGE: ресурсы ВСЕГДА фиксированы — 60 минут и 60 попыток,
         это условие челленджа и оно не меняется (настройки карты игнорируются). */
      const sm = map.mode === 'skill' ? 60 : Math.max(5, Math.min(180, Math.floor(map.startMin ?? START_SEC / 60)));
      const st = map.mode === 'skill' ? 60 : Math.max(5, Math.min(180, Math.floor(map.startTries ?? START_TRIES)));
      // МОНЕТЫ: стартовый капитал — только если автор включил их на карте
      const sc0 = map.startCoins !== undefined ? Math.max(0, Math.min(COINS_MAX, Math.floor(map.startCoins))) : 0;
      // все игроки начинают на СТАРТОВОЙ ячейке (первая с типом «старт», иначе №1)
      const startPos = startCellIdx(map);
      for (const p of s.players) {
        p.secLeft = sm * 60; p.triesLeft = st; p.coinsLeft = sc0; p.pos = startPos;
        if (soloMode) p.spect = !p.isHost; // играет только хост — остальные смотрят
        if (map.mode === 'rubg') { p.hp = RUBG_HP_MAX; p.items = [{ ...rubgMkItem('lockpick'), belt: true }]; p.stealth = false; } // стартовая ОТМЫЧКА на поясе — механику взлома можно пробовать сразу
      }
      /* RUBG: САМОЛЁТ через карту — бойцы выпрыгивают, ГДЕ ХОЧУТ (стартовая ячейка НЕ нужна:
         в редакторе RUBG-карту можно завершить без неё). Зона — когда все выпрыгнут. */
      if (map.mode === 'rubg') {
        const W = map.mw ?? map.cols * CELL_PX;
        const H = map.mh ?? map.rows * CELL_PX;
        const ang = Math.random() * Math.PI * 2;
        const half = Math.hypot(W, H) / 2 + CELL_PX;
        const cx0 = W / 2, cy0 = H / 2;
        s.rubg = {
          plane: {
            x0: cx0 - Math.cos(ang) * half, y0: cy0 - Math.sin(ang) * half,
            x1: cx0 + Math.cos(ang) * half, y1: cy0 + Math.sin(ang) * half,
            startAt: Date.now(), speed: Math.max(W, H) / 22, jumped: [],
          },
          zone: null, // зона появится, когда все выпрыгнут (rubgJump / тик хоста)
          jobs: {}, looted: [], stealth: [], steals: {}, stopCd: {},
        };
      }
      /* БЕЗКАРТОВАЯ ИГРА (СТАРЫЕ карты v0.36.0): счётчик матчей.
         SKILL CHALLENGE снова играется НА КАРТЕ — счётчик ему не нужен. */
      const mlTotal = map.mapless?.total ?? 0;
      if (mlTotal > 0) s.mapless = { done: 0, total: mlTotal, over: false };
      if (isJourneyLike(map.mode)) {
        // фишка хоста стартует ОДНОВРЕМЕННО (в JOURNEY — фишки ВСЕХ игроков);
        // жеребьёвки нет — панель готовности (в JOURNEY SOLO она у хоста одна)
        const sc = map.cells[startPos];
        const scx = sc ? (sc.cx ?? (sc.x + (sc.w || 1) / 2) * CELL_PX) : 0;
        const scy = sc ? (sc.cy ?? (sc.y + (sc.h || 1) / 2) * CELL_PX) : 0;
        s.journeyPos = {};
        for (const p of s.players) s.journeyPos[p.id] = { x: scx, y: scy };
      }
      s.phase = 'rollOff';
      s.rollOffIdx = 0;
      s.rollOffValues = {};
      s.rollOffReady = [];
      s.skillDone = [];
      if (isJourneyLike(map.mode)) s.rollOffWinner = s.players[0]?.id ?? null; // без бросков: сразу панель готовности
      /* БЕЗ КАРТЫ (старые челленджи без карты): жеребьёвка не нужна —
         сразу панель готовности хоста (без кубиков). SKILL CHALLENGE — на карте, с жеребьёвкой. */
      if (map.mapless) s.rollOffWinner = s.players.find((p) => p.isHost)?.id ?? null;
      const taskTotal = map.cells.filter((c) => c.type === 'task').length;
      log(map.mode === 'rubg'
        ? `🪂 RUBG! ${s.players.length} бойцов на борту. Самолёт летит — ПРЫГАЙТЕ, где хотите! Ресурс — полоска HP, у каждого ОТМЫЧКА 🔑 для ящиков. Побеждает последний живой!`
        : isQuestMode(map.mode)
          ? `🗺 QUEST! ${isSoloMode(map.mode) ? 'Играет хост — зрители смотрят трансляцию. ' : 'Каждый играет ИНДИВИДУАНО, трансляции нет. '}Задания — на доверии: вошёл в ячейку, играй и жми «Победа/Поражение». Побеждает ПЕРВЫЙ, кто выполнит КОНЦОВКУ${(map.endings ?? []).length ? ` (концовок: ${(map.endings ?? []).length})` : ''}!`
          : map.mode === 'classic1p'
            ? `🎲 RETROPOLIA SOLO! Играет только хост (${sm} мин / ${st} поп.) — победа: пройти ВСЕ задания карты (заданий: ${taskTotal}).`
            : soloMode && map.mode === 'skill'
          ? `🧨 SKILL CHALLENGE! Играет только хост — ${SKILL_TURNS} заданий на карте. Остальные — зрители.`
          : map.mapless
            ? `🎲 ЧЕЛЛЕНДЖ БЕЗ КАРТЫ! Матчей: ${mlTotal}${map.mapless.random ? ' (рандомайзер)' : ''} — играет только хост (${sm} мин / ${st} поп.${map.startCoins !== undefined ? `, монет: ${sc0}` : ''}).`
            : soloMode && map.mode === 'journey1p'
              ? `🧭 JOURNEY SOLO! Играет только хост (${sm} мин / ${st} поп.) — остальные зрители. Победа: пройти ВСЕ задания карты (заданий: ${taskTotal}).`
              : isJourneyLike(map.mode)
                ? `🧭 JOURNEY! У каждого: ${sm} мин и ${st} поп. Все фишки стартуют ОДНОВРЕМЕННО — кто первый пересечёт ячейку задания, тот и играет.`
                : `Игра начинается! У каждого: ${sm} мин и ${st} поп. Бросок за первый ход…`);
      break;
    }
    case 'roll': {
      if (s.phase === 'rollOff') {
        /* жеребьёвка — только среди ИГРАЮЩИХ (в SKILL CHALLENGE зрители не бросают) */
        const roster = s.players.filter((p) => !p.spect);
        if (s.rollOffIdx >= roster.length) break;
        const p = roster[s.rollOffIdx];
        if (p.id !== a.id) break;
        /* игрок влияет на бросок временем удержания: чем дольше тряс,
           тем больше «перемешиваний» (до 6). Результат вычисляется хостом
           в момент прихода действия — отсюда небольшая задержка остановки. */
        const shuffles = Math.min(6, 1 + Math.floor(Math.max(0, a.holdMs) / 450));
        let v = rnd6();
        for (let i = 1; i < shuffles; i++) v = rnd6();
        s.rollOffValues[p.id] = v;
        s.rollOffIdx++;
        log(`🎲 ${p.name} выбрасывает ${v}`);
        if (s.rollOffIdx >= roster.length) {
          const vals = roster.map((p) => s.rollOffValues[p.id] ?? 0);
          const max = Math.max(...vals);
          const leaders = roster.filter((p) => (s.rollOffValues[p.id] ?? 0) === max);
          if (leaders.length === 1) {
            // фиксируем победителя, но не стартуем сразу: всем показывается экран
            // «первым ходит …», а запуск подтверждает действие rollOffGo
            s.turn = s.players.indexOf(leaders[0]);
            s.rollOffWinner = leaders[0].id;
            log(`🎲 Первым ходит ${leaders[0].name}!`);
          } else {
            s.rollOffValues = {};
            s.rollOffIdx = 0;
            log('Ничья! Бросаем ещё раз…');
          }
        }
        break;
      }
      if (s.phase !== 'playing') break;
      if (isJourneyLike(map.mode)) break; // JOURNEY/JOURNEY SOLO/RUBG: кубиков нет — ходят фишкой напрямую
      if (gatingFx()) break; // идёт анимация победы/поражения — ждём её
      const p = current();
      if (!p || p.id !== a.id || s.moving || s.challenge || s.pendingCard || s.awaitPost || s.quiz) break;
      s.notice = null;
      /* пакость «Кубики-0»: кто стоит на ячейке с этой пакостью (и не является её
         хозяином) — бросает 0 и застревает, пока задание не пройдено и не заменено */
      const tCur = cellTaskOf(s, map, p.pos);
      const cursed = tCur?.chaos === 'dice0' && s.captured[p.pos] !== p.id;
      const oneDieRoll = !!p.oneDie && !cursed;
      const threeDice = !!p.dicePlus && !oneDieRoll && !cursed;
      p.oneDie = false;
      p.dicePlus = false;
      if (cursed) {
        s.dice = { a: 0, b: 0, count: 2, zero: true, roll: (s.dice?.roll ?? 0) + 1 };
        s.moving = { player: p.id, path: [p.pos], ts: Date.now() };
        log(`🎲 😈 Кубики-0: ${p.name} застревает на ячейке №${p.pos + 1} — пройдите задание!`);
        break;
      }
      /* игрок влияет на бросок временем удержания кнопки: чем дольше перемешивал,
         тем больше «перемешиваний» (до 6). Результат вычисляется хостом, когда
         приходит действие, поэтому после отпускания есть небольшая задержка —
         кубики «докатываются», пока не придут официальные числа. */
      const shuffles = Math.min(6, 1 + Math.floor(Math.max(0, a.holdMs) / 450));
      let va = rnd6();
      for (let i = 1; i < shuffles; i++) va = rnd6();
      const vb = rnd6();
      if (oneDieRoll) {
        s.dice = { a: va, b: 0, count: 1, roll: (s.dice?.roll ?? 0) + 1 };
        const path: number[] = [];
        let c = p.pos;
        for (let i = 1; i <= va; i++) { c = stepNext(map, c); path.push(c); }
        const oh = hopTargetOf(map, path[path.length - 1]);
        if (oh !== path[path.length - 1]) { path.push(oh); log(`↳ переход по стрелке → ${posName(oh)}`); }
        s.moving = { player: p.id, path, ts: Date.now() };
        log(`🎲 😈 ${p.name}: один кубик — ${va}`);
        break;
      }
      const vc = threeDice ? rnd6() : 0;
      s.dice = { a: va, b: vb, ...(threeDice ? { c: vc, count: 3 } : { count: 2 }), roll: (s.dice?.roll ?? 0) + 1 };
      const path: number[] = [];
      const steps = va + vb + (threeDice ? vc : 0);
      let c2 = p.pos;
      for (let i = 1; i <= steps; i++) { c2 = stepNext(map, c2); path.push(c2); }
      const nh = hopTargetOf(map, path[path.length - 1]);
      if (nh !== path[path.length - 1]) { path.push(nh); log(`↳ переход по стрелке → ${posName(nh)}`); }
      s.moving = { player: p.id, path, ts: Date.now() };
      log(`🎲 ${p.name}: ${va} + ${vb}${threeDice ? ` + ${vc}` : ''} = ${steps}${threeDice ? ' (3 кубика!)' : ''}`);
      break;
    }
    case 'rollOffGo': {
      // подтверждение старта после жеребьёвки: все уже увидели, кто ходит первым
      if (s.phase !== 'rollOff' || !s.rollOffWinner) break;
      const w = s.players.find((p) => p.id === s.rollOffWinner);
      s.phase = 'playing';
      log(`🚀 Игра началась! Ход ${w?.name ?? '—'}`);
      break;
    }
    case 'rollOffReady': {
      // игрок подтвердил, что готов начать игру; старт происходит, когда готовы ВСЕ.
      // В JOURNEY жеребьёвки нет — панель готовности открывается сразу после старта
      if (s.phase !== 'rollOff') break;
      if (!s.rollOffWinner && !isJourneyLike(map.mode)) break;
      const p = actor();
      if (!p) break;
      /* фишки партии: пока игрок не взял свою фишку из набора карты — готовым не считается */
      if ((map.mapTokens?.length ?? 0) > 0 && !p.tokenKey) break;
      if (!s.rollOffReady) s.rollOffReady = [];
      if (!s.rollOffReady.includes(a.id)) {
        s.rollOffReady.push(a.id);
        log(`✔ ${p.name}: готов начать`);
      }
      if (s.players.filter((pl) => !pl.spect).every((pl) => (s.rollOffReady ?? []).includes(pl.id))) {
        /* RUBG с САМОЛЁТОМ: панель готовности не используется — переход в игру делает
           ПРЫЖОК последнего бойца (rubgJump) или форс-высадка в тике хоста */
        if (map.mode === 'rubg' && s.rubg?.plane) break;
        s.phase = 'playing';
        if (map.mode === 'rubg') {
          rubgStartZone(); // старая сессия без самолёта — запускаем безопасную зону
          log('🚀 Все готовы! RUBG начался. Побеждает последний живой!');
        } else if (isJourneyLike(map.mode)) {
          log(map.mode === 'journey1p'
            ? '🚀 Все готовы! Игра началась — фишка хоста пошла'
            : '🚀 Все готовы! Фишки пошли ОДНОВРЕМЕННО — кто первый пересечёт ячейку задания, у того и откроется задание');
        } else {
          const w = s.players.find((pl) => pl.id === s.rollOffWinner);
          log(`🚀 Все готовы! Игра началась — ход ${w?.name ?? '—'}`);
        }
      }
      break;
    }
    case 'arrived': {
      if (s.phase !== 'playing' || !s.moving) break;
      const p = current();
      if (p.id !== a.id) break;
      p.pos = s.moving.path[s.moving.path.length - 1];
      s.moving = null;
      if (!s.revealed.includes(p.pos)) s.revealed.push(p.pos);
      resolveLanding();
      break;
    }
    /* ---------- JOURNEY / JOURNEY SOLO / RUBG: прямое управление фишкой ----------
       JOURNEY — все игроки ходят ОДНОВРЕМЕННО; JOURNEY SOLO — только хост, остальные зрители. */
    case 'journeyMove': {
      if (s.phase !== 'playing' || !isJourneyLike(map.mode)) break;
      /* Очередь ходов отсутствует — каждый игрок ведёт СВОЮ фишку
         (авторитет проверок — хост). Зритель и выбывший не ходят. */
      const p = s.players.find((x) => x.id === a.id);
      if (!p || p.spect || !p.alive) break;
      if (s.moving || s.challenge || s.pendingCard || s.quiz || s.awaitPost || gatingFx()) break;
      const mszW = map.mw ?? map.cols * CELL_PX;
      const mszH = map.mh ?? map.rows * CELL_PX;
      let x = Math.max(0, Math.min(mszW, Number(a.x) || 0));
      let y = Math.max(0, Math.min(mszH, Number(a.y) || 0));
      const prev = s.journeyPos?.[p.id] ?? null;
      /* ПЛИТОЧНЫЙ РЕЖИМ КАРТ: фишка не может покинуть СВОЮ карту-плитку — ходьба
         зажимается в её прямоугольник. Обновление с tp (прыжок через портал)
         НЕ зажимается — оно легально попадает на ДРУГУЮ карту-плитку. */
      if (map.tileGrid && !a.tp) {
        const cl = clampToTile(map, x, y, prev?.x ?? x, prev?.y ?? y);
        x = cl.x; y = cl.y;
      }
      /* НЕВИДИМЫЕ СТЕНЫ: фишка не может зайти в стену (клиент скользит по стене сам —
         сюда точка внутри стены попадает только при рассинхроне) */
      if (pointInWall(map, x, y, s.wallsRemoved)) break;
      /* защита от телепортаций: одно обновление не дальше 2.5 клеток от прошлой позиции.
         СТОП-обновление (mv=false) принимаем всегда — игрок реально стоит в этой точке,
         иначе при сетевом заторе цепочка отклонённых апдейтов «застревала» надолго. */
      const stopped = a.mv === false;
      /* ПОРТАЛ: обновление с tp — фишка вошла в зону портала и МГНОВЕННО перенеслась
        в точку перехода (обычно на другой плитке) — прыжок на любое расстояние легален.
        Без tp — прежняя защита от телепортаций: не дальше 2.5 клеток за одно обновление.
        СТОП-обновление (mv=false) принимаем всегда — игрок реально стоит в этой точке,
        иначе при сетевом заторе цепочка отклонённых апдейтов «застревала» надолго. */
      if (prev && !stopped && !a.tp && Math.hypot(x - prev.x, y - prev.y) > CELL_PX * 2.5) break;
      s.journeyPos = s.journeyPos ?? {};
      s.journeyPos[p.id] = { x, y, dir: a.dir, ts: Date.now(), mv: a.mv !== false, tp: a.tp || undefined };
      /* RUBG: вход в ячейку — ЛИЧНОЕ задание (никого не останавливает). ЯЩИКИ больше
         НЕ вскрываются проходом — только взломом (отмычка/сила). Стелс слетает при входе в ячейку. */
      if (map.mode === 'rubg' && s.rubg) {
        const rg = s.rubg;
        rg.jobs = rg.jobs ?? {};
        rg.stealth = rg.stealth ?? [];
        for (let i = 0; i < map.cells.length; i++) {
          const c = map.cells[i];
          const r = cellRectOf(map, i);
          if (!r) continue;
          const inNew = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
          if (!inNew) continue;
          const inOld = !!prev && prev.x >= r.x && prev.x < r.x + r.w && prev.y >= r.y && prev.y < r.y + r.h;
          if (inOld) continue; // уже стоял в ней — вход был раньше
          p.pos = i;
          if (!s.revealed.includes(i)) s.revealed.push(i);
          if (c.type === 'task') {
            rubgTryJob(p, i, true); // ОДНА ячейка — ОДИН игрок: занятая другим — отказ с пояснением
          }
        }
        break;
      }
      /* QUEST / QUEST SOLO: КАЖДЫЙ играет ИНДИВИДУАНО — вход в ячейку задания открывает
         ЛИЧНОЕ задание (на доверие), НЕ останавливая других и БЕЗ трансляции. Одну и ту
         же ячейку каждый победивает сам. Бонусы/ловушки выдают карточку вошедшему.
         Квизовых ячеек в QUEST нет (запрещены редактором). */
      if (isQuestMode(map.mode)) {
        for (let i = 0; i < map.cells.length; i++) {
          const c = map.cells[i];
          const r = cellRectOf(map, i);
          if (!r) continue;
          const inNew = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
          if (!inNew) continue;
          const inOld = !!prev && prev.x >= r.x && prev.x < r.x + r.w && prev.y >= r.y && prev.y < r.y + r.h;
          if (inOld) continue; // уже стоял в ней — вход был раньше
          p.pos = i;
          if (!s.revealed.includes(i)) s.revealed.push(i);
          if (c.type === 'task') {
            if ((s.qDone?.[p.id] ?? []).includes(i)) continue; // это задание игрок УЖЕ победил
            if (s.qJobs?.[p.id]) continue; // уже играешь личное задание
            const tk = cellTaskOf(s, map, i);
            if (!tk) continue; // задания нет — передышка
            s.qJobs = s.qJobs ?? {};
            s.qJobs[p.id] = { cellIdx: i, startedAt: Date.now() };
            log(`🎯 ${p.name} взял задание «${tk.title.slice(0, 30)}» — ЛИЧНО, остальные не ждут`);
          } else if (c.type === 'bonus' || c.type === 'trap') {
            const deck = c.type === 'bonus' ? map.bonusCards : map.trapCards;
            if (!deck.length) continue;
            const card = deck[Math.floor(Math.random() * deck.length)];
            applyCard(p, card, true);
            s.qCards = s.qCards ?? {};
            s.qCards[p.id] = card;
            log(`${c.type === 'bonus' ? '🌟 БОНУС' : '☠ ЛОВУШКА'} для ${p.name}: «${card.name}»`);
          }
        }
        break;
      }
      /* пересёк ячейку задания? вход = прошлый центр был ВНЕ прямоугольника, новый — ВНУТРИ.
        КТО ПЕРВЫЙ пересёк — у того и задание: turn = этот игрок (все фишки замирают,
        остальные смотрят трансляцию — «всё как всегда»); после задания все снова ходят. */
      if (!s.challenge) {
        for (let i = 0; i < map.cells.length; i++) {
          const c = map.cells[i];
          if (c.type !== 'task') continue;
          if (s.broken?.[i]) continue; // разбитая ячейка пуста — задание не открывается
          const r = cellRectOf(map, i);
          if (!r) continue;
          const inNew = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
          if (!inNew) continue;
          const inOld = !!prev && prev.x >= r.x && prev.x < r.x + r.w && prev.y >= r.y && prev.y < r.y + r.h;
          if (inOld) continue; // уже стоял в ней — вход был раньше (перешёл границу — заново)
          if (s.captured[i] === p.id) continue; // своя ячейка — отдых
          if (!cellTaskOf(s, map, i)) continue; // задания нет — обычная ячейка
          p.pos = i;
          if (!s.revealed.includes(i)) s.revealed.push(i);
          s.turn = Math.max(0, s.players.indexOf(p)); // игрок задания — «текущий»: камера/боссы/окно на нём
          s.challenge = {
            cellIdx: i, mode: null, started: false, paused: false, startedAt: 0, accMs: 0, loads: 0, reloadId: 0,
            status: 'choose', approvals: [], violations: [], lowStart: false,
          };
          /* ТОЛЬКО МОНЕТЫ: без окна выбора — задание сразу готово (платёж по итогам) */
          if (map.coinsOnly && map.startCoins !== undefined) {
            s.challenge.mode = 'coins';
            s.challenge.status = 'ready';
          } else if (map.resMode === 'hp') {
            s.challenge.mode = 'hp'; // ресурс «полоска HP» — плата по итогам
            s.challenge.status = 'ready';
          } else if (map.resMode === 'time' || map.resMode === 'tries') {
            s.challenge.mode = map.resMode; // ОДИН ресурс — выбора нет
            s.challenge.status = 'ready';
          }
          const owner = s.captured[i] ? s.players.find((pl) => pl.id === s.captured[i]) : null;
          log(`🎯 ${p.name} ПЕРВЫМ пересёк ячейку ${posName(i)} — задание его!${owner ? ` (хозяин ${owner.name})` : ''}`);
          break;
        }
      }
      break;
    }
    case 'fxDone': {
      // анимация победы/поражения у игрока закончилась — снимаем блокировку хода
      const fx = (s.fxs ?? []).find((f) => f.gate);
      if (!fx || fx.player !== a.id) break;
      s.fxs = (s.fxs ?? []).filter((f) => f.id !== fx.id);
      /* после поражения ход уходит следующему — но ТОЛЬКО если проигравший до сих пор
         активен: checkElim мог уже передать ход (проигравший выбыл по ресурсам),
         и повторный endTurn пропускал бы очередь */
      if (fx.after === 'endTurn' && current().id === fx.player) endTurnNow();
      // after === 'post': awaitPost уже выставлен — окно выбора откроется само
      break;
    }
    case 'fxBreak': {
      // спектакль победы дошёл до момента разбития: пауза прошла, анимации начались —
      // ячейка разлетается осколками и становится разбитой (пустой, хозяин — победитель)
      if (s.phase !== 'playing') break;
      const fx = (s.fxs ?? []).find((f) => f.gate);
      if (!fx || fx.player !== a.id || fx.after !== 'post') break;
      if (s.broken?.[fx.cellIdx]) break;
      s.broken = s.broken ?? {};
      s.broken[fx.cellIdx] = { by: fx.player, left: 2, at: Date.now() };
      const wn = s.players.find((x) => x.id === fx.player)?.name ?? '';
      log(`💥 ${wn} побеждает и РАЗБИВАЕТ ячейку №${fx.cellIdx + 1}!`);
      break;
    }
    /* ---------- БЕЗ КАРТЫ: челлендж без карты и SKILL CHALLENGE (25 случайных игр) ----------
       Экран карты не показывается: хост крутит рандомайзер (или идёт по списку) —
       выпавшая игра записывается в текущий матч и открывается задание. */
    case 'maplessSpin': {
      const host = s.players.find((p) => p.isHost);
      if (s.phase !== 'playing' || !host || a.id !== host.id) break;
      if (!map.mapless?.random && map.mode !== 'skill') break; // рандомайзер есть только там
      const cell = map.cells[a.cellIdx];
      if (!cell || cell.type !== 'task') break;
      s.sessionTasks = s.sessionTasks ?? {};
      s.sessionTasks[a.cellIdx] = {
        romId: a.romId,
        title: a.title.slice(0, 40) || 'Случайная игра',
        desc: map.mode === 'skill'
          ? `Случайный матч из рандомайзера (хост крутит колесо — играется выпавшее)`
          : 'Случайный матч: игра выпала из рандомайзера челленджа',
      };
      log(`🎰 Рандомайзер остановился: «${a.title.slice(0, 40)}» — матч ${(s.mapless?.done ?? 0) + 1} из ${s.mapless?.total ?? '?'}`);
      break;
    }
    case 'maplessOpen': {
      const host = s.players.find((p) => p.isHost);
      if (s.phase !== 'playing' || !host || a.id !== host.id) break;
      if (!map.mapless && map.mode !== 'skill') break;
      if (s.challenge || s.moving || s.pendingCard || s.quiz || s.awaitPost || gatingFx()) break;
      const cell = map.cells[a.cellIdx];
      if (!cell || cell.type !== 'task') break;
      if (!cellTaskOf(s, map, a.cellIdx)) break; // задания нет (рандом ещё не крутанут) — открывать нечего
      if ((s.skillDone ?? []).includes(a.cellIdx)) break; // матч уже сыгран
      const p = host;
      p.pos = a.cellIdx;
      s.turn = Math.max(0, s.players.indexOf(p));
      if (!s.revealed.includes(a.cellIdx)) s.revealed.push(a.cellIdx);
      s.notice = null;
      s.challenge = {
        cellIdx: a.cellIdx, mode: null, started: false, paused: false, startedAt: 0, accMs: 0, loads: 0, reloadId: 0,
        status: 'choose', approvals: [], violations: [], lowStart: false,
      };
      /* ТОЛЬКО МОНЕТЫ: без окна выбора — задание сразу готово (платёж по итогам) */
      if (map.coinsOnly && map.startCoins !== undefined) {
        s.challenge.mode = 'coins';
        s.challenge.status = 'ready';
      } else if (map.resMode === 'hp') {
        s.challenge.mode = 'hp'; // ресурс «полоска HP» — плата по итогам
        s.challenge.status = 'ready';
      }
      log(`🎯 ${p.name} открывает матч ${(s.mapless?.done ?? 0) + 1} из ${s.mapless?.total ?? '?'}`);
      break;
    }
    case 'maplessFinish': {
      const host = s.players.find((p) => p.isHost);
      if (s.phase !== 'playing' || !host || a.id !== host.id) break;
      if (!s.mapless?.over) break; // матчи ещё не все сыграны
      if (s.challenge || s.pendingCard || s.quiz || s.awaitPost || gatingFx()) break;
      s.phase = 'over';
      s.winner = host.alive && !host.spect ? host.id : null;
      log(`🏆 ЧЕЛЛЕНДЖ ПРОЙДЕН! ${host.name} сыграл все ${s.mapless.total} матчей${s.winner ? ` — капитал ${coinsStr(host.coinsLeft ?? 0)}` : ''}`);
      break;
    }
    /* ---------- RUBG (Retro Ultimate Battle Ground) — «ретро-PUBG» ----------
       Самолёт, прыжки, ЛИЧНЫЕ задания без остановки других (доверие), полоска HP,
       сжимающаяся зона, лутбоксы, стелс, атаки и кражи. Побеждает последний живой. */
    case 'rubgJump': {
      if (s.phase !== 'rollOff' || map.mode !== 'rubg' || !s.rubg?.plane) break;
      const p = actor();
      if (!p || p.spect || !p.alive) break;
      /* фишки партии: без выбранной фишки прыгать нельзя (как и «Старт игры» без неё) */
      if ((map.mapTokens?.length ?? 0) > 0 && !p.tokenKey) break;
      const pl = s.rubg.plane;
      if (pl.jumped.includes(a.id)) break;
      const W = map.mw ?? map.cols * CELL_PX;
      const H = map.mh ?? map.rows * CELL_PX;
      const x = Math.max(16, Math.min(W - 16, Number(a.x) || 0));
      const y = Math.max(16, Math.min(H - 16, Number(a.y) || 0));
      /* точка должна лежать у линии полёта (под самолётом; запас 2 клетки — на пинг) */
      const dxs = pl.x1 - pl.x0, dys = pl.y1 - pl.y0;
      const len2 = dxs * dxs + dys * dys;
      const t = Math.max(0, Math.min(1, ((x - pl.x0) * dxs + (y - pl.y0) * dys) / (len2 || 1)));
      const distLine = Math.hypot(x - (pl.x0 + dxs * t), y - (pl.y0 + dys * t));
      if (distLine > CELL_PX * 2) break; // далеко от линии — не прыгаем
      pl.jumped.push(a.id);
      s.journeyPos = s.journeyPos ?? {};
      s.journeyPos[p.id] = { x, y, ts: Date.now(), mv: false };
      log(`🪂 ${p.name} ПРЫГНУЛ из самолёта!`);
      const roster = s.players.filter((q) => !q.spect);
      if (roster.every((q) => pl.jumped.includes(q.id))) {
        s.phase = 'playing';
        log('🚀 ВЫСАДКА ЗАВЕРШЕНА — все на земле! RUBG начался. Побеждает последний живой!');
        rubgLandingJobs(); // кто приземлился прямо в ячейку лутбокса/задания — сразу получает её
        rubgStartZone();
      }
      break;
    }
    case 'rubgTick': {
      const host = s.players.find((p) => p.isHost);
      if (map.mode !== 'rubg' || !s.rubg || !host || a.id !== host.id) break;
      const rg = s.rubg;
      const now = Date.now();
      const W = map.mw ?? map.cols * CELL_PX;
      const H = map.mh ?? map.rows * CELL_PX;
      /* фаза полёта: неспрыгнувших высаживаем в конце линии через 8 с после прилёта */
      if (s.phase === 'rollOff' && rg.plane) {
        const pl = rg.plane;
        const flightMs = (Math.hypot(pl.x1 - pl.x0, pl.y1 - pl.y0) / pl.speed) * 1000;
        if (now > pl.startAt + flightMs + 8000) {
          const late = s.players.filter((q) => !q.spect && !pl.jumped.includes(q.id));
          for (const q of late) {
            pl.jumped.push(q.id);
            s.journeyPos = s.journeyPos ?? {};
            s.journeyPos[q.id] = { x: pl.x1, y: pl.y1, ts: now, mv: false };
            log(`🪂 ${q.name} высажен принудительно (не прыгнул)`);
          }
        }
        if (s.players.filter((q) => !q.spect).every((q) => pl.jumped.includes(q.id))) {
          s.phase = 'playing';
          log('🚀 ВЫСАДКА ЗАВЕРШЕНА — все на земле!');
          rubgLandingJobs(); // кто приземлился прямо в ячейку лутбокса/задания — сразу получает её
        } else break; // ещё летим — остальное не тикает
      }
      if (s.phase !== 'playing') break;
      rg.jobs = rg.jobs ?? {}; rg.looted = rg.looted ?? []; rg.stealth = rg.stealth ?? [];
      rg.steals = rg.steals ?? {}; rg.stopCd = rg.stopCd ?? {};
      rg.shots = (rg.shots ?? []).filter((x) => now - x.ts < 2000); // старые пули чистим
      rubgStartZone(); // фолбэк: старая сессия без зоны — создаём при первом тике игры
      /* зависшие кражи: время давно вышло — закрываем как провал */
      for (const [vid, st] of Object.entries(rg.steals)) {
        if (now - st.startedAt > st.dur * 1000 + 2500) {
          delete rg.steals[vid];
          const th = s.players.find((q) => q.id === st.thief);
          if (th) { th.stealth = false; rg.stealth = rg.stealth.filter((x) => x !== th.id); }
          log(`💨 Кража у ${s.players.find((q) => q.id === vid)?.name ?? '?'} сорвалась — вор ушёл ни с чем`);
        }
      }
      /* ЗОНА: фазы, сжатие, урон вне круга. Работает по ПЛАНУ фаз (создан при появлении зоны:
         авторские пауза/сжатие/сужение в клетках или дефолт×масштаб zoneSec). Старая сессия без
         плана — достраиваем на первом тике (фолбэк, чтобы партия не сломалась на лету). */
      const z = rg.zone;
      if (z && !z.plan) {
        const r00 = Math.hypot(W, H) / 2 * 0.75;
        z.plan = rubgBuildPlan(z.r <= r00 ? z.r : r00); // старая зона: цепочку строим от её текущего радиуса
      }
      if (z) {
        const PLAN = z.plan ?? RUBG_ZONE_PHASES.map((p) => ({ wait: 0, shrink: 1, dps: p.dps, distPx: 0 }));
        const ph = PLAN[Math.min(z.idx, PLAN.length - 1)];
        if (z.phase === 'wait' && now >= z.phaseEnd && z.idx < PLAN.length) {
          /* цель (tx/ty/tr) УЖЕ посчитана при завершении прошлого сжатия (или при создании зоны) —
             пунктир-превью показывал её всё время ожидания; здесь только запускаем сжатие */
          z.phase = 'shrink';
          z.sx = z.cx; z.sy = z.cy; z.sr = z.r;
          z.phaseStart = now;
          z.phaseEnd = now + Math.max(1000, Math.round(ph.shrink * 1000));
          log(`⚠ ЗОНА СЖИМАЕТСЯ! Беги в круг! (${rubgFmtZone(ph.shrink)})`);
        } else if (z.phase === 'shrink') {
          const t = Math.max(0, Math.min(1, (now - z.phaseStart) / Math.max(1, z.phaseEnd - z.phaseStart)));
          z.cx = z.sx + (z.tx - z.sx) * t;
          z.cy = z.sy + (z.ty - z.sy) * t;
          z.r = z.sr + (z.tr - z.sr) * t;
          if (now >= z.phaseEnd) {
            z.cx = z.tx; z.cy = z.ty; z.r = z.tr;
            z.idx = Math.min(z.idx + 1, PLAN.length - 1);
            const np = PLAN[z.idx];
            z.phase = 'wait';
            z.phaseStart = now;
            z.phaseEnd = now + Math.round(np.wait * 1000);
            z.dps = np.dps;
            /* цель СЛЕДУЮЩЕГО сжатия: сужение в КЛЕТКАХ (np.distPx) — сразу, чтобы
               во время ожидания пунктир-превью показывал, куда сожмётся */
            const ntr = Math.max(0, z.r - np.distPx);
            const off = Math.max(0, z.r - ntr) * 0.7;
            z.tx = Math.max(0, Math.min(W, z.cx + (Math.random() * 2 - 1) * off));
            z.ty = Math.max(0, Math.min(H, z.cy + (Math.random() * 2 - 1) * off));
            z.tr = ntr;
            log(z.r <= 1 ? `☠ Зона закрыла ВСЮ карту — HP тает у всех по ${np.dps}%/с!` : `⭕ Зона сузилась — следующее сжатие через ${rubgFmtZone(np.wait)} (вне зоны ${np.dps}%/с)`);
          }
        }
        /* урон вне зоны (по интерполированному кругу) */
        const dt = Math.min(6, Math.max(0, (now - z.lastTick) / 1000));
        z.lastTick = now;
        if (dt > 0.2) {
          for (const p of s.players) {
            if (!p.alive || p.spect) continue;
            const px = playerPx(s, map, p.id);
            if (!px) continue;
            if (Math.hypot(px.x - z.cx, px.y - z.cy) > z.r) {
              p.hp = Math.max(0, (p.hp ?? RUBG_HP_MAX) - z.dps * dt);
            }
          }
        }
      }
      checkElim();
      break;
    }
    case 'rubgJobDone': {
      if (s.phase !== 'playing' || map.mode !== 'rubg' || !s.rubg) break;
      const p = actor();
      const rg = s.rubg;
      rg.jobs = rg.jobs ?? {};
      const job = p ? rg.jobs[p.id] : undefined;
      if (!p || !job || job.cellIdx !== a.cellIdx) break;
      delete rg.jobs[p.id];
      if (a.win) {
        p.hp = Math.min(RUBG_HP_MAX, (p.hp ?? RUBG_HP_MAX) + RUBG_WIN_HP);
        const kind = rubgRandomKind();
        rubgGiveItem(p, kind); // на пояс, если есть слот (макс. 3), иначе в общий инвентарь
        s.captured[a.cellIdx] = p.id; // мгновенный хозяин ячейки (своё задание в RUBG не предлагается)
        log(`🏆 ${p.name} ПРОШЁЛ задание №${a.cellIdx + 1}: +${RUBG_WIN_HP}% HP, трофей ${RUBG_ITEMS[kind].icon} ${RUBG_ITEMS[kind].name} — HP ${p.hp}%`);
      } else {
        p.hp = Math.max(0, (p.hp ?? RUBG_HP_MAX) - RUBG_LOSE_HP);
        log(`💢 ${p.name} проиграл задание №${a.cellIdx + 1}: −${RUBG_LOSE_HP}% HP — HP ${p.hp}%`);
      }
      checkElim();
      break;
    }
    case 'rubgJobLeave': {
      if (map.mode !== 'rubg' || !s.rubg) break;
      const rg = s.rubg;
      rg.jobs = rg.jobs ?? {};
      const p = actor();
      const job = p ? rg.jobs[p.id] : undefined;
      if (!p || !job || job.cellIdx !== a.cellIdx) break;
      delete rg.jobs[p.id];
      log(`🚶 ${p.name} отошёл от задания №${a.cellIdx + 1} — можно зайти снова`);
      break;
    }
    /* ---------- QUEST / QUEST SOLO: задания на доверии, карточки, диалоги и квесты NPC ---------- */
    case 'qJobDone': {
      if (s.phase !== 'playing' || !isQuestMode(map.mode)) break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const job = s.qJobs?.[p.id];
      if (!job || job.cellIdx !== a.cellIdx) break;
      delete s.qJobs![p.id];
      /* ресурс партии: время списывается по факту (минуты за задание); монеты/HP — платёж по итогам; попытка — 1 за вход */
      const resM = map.resMode ?? ((map.coinsOnly && map.startCoins !== undefined) ? 'coins' : 'std');
      if (resM === 'time' || resM === 'std') {
        const mins = Math.max(0, Math.ceil((Date.now() - job.startedAt) / 60000));
        const spend = Math.min(mins, Math.floor(p.secLeft / 60)) * 60;
        if (spend > 0) p.secLeft -= spend;
        if (resM === 'std') p.triesLeft = Math.max(0, p.triesLeft - 1); // вход в задание = 1 попытка
      } else if (resM === 'tries') {
        p.triesLeft = Math.max(0, p.triesLeft - 1);
      }
      if (a.win) {
        s.qDone = s.qDone ?? {};
        const done = s.qDone[p.id] ?? [];
        if (!done.includes(a.cellIdx)) done.push(a.cellIdx);
        s.qDone[p.id] = done;
        s.captured[a.cellIdx] = p.id; // визуальная отметка ячейки (прогресс у каждого свой)
        if (resM === 'coins') {
          const wc = Math.max(0, Math.floor(map.taskWinCoins ?? 0));
          if (wc > 0) { p.coinsLeft = Math.min(COINS_MAX, (p.coinsLeft ?? 0) + wc); log(`🪙 Награда: +${wc} бронзы — капитал ${coinsStr(p.coinsLeft)}`); }
        }
        if (resM === 'hp') { p.hp = Math.min(RUBG_HP_MAX, (p.hp ?? RUBG_HP_MAX) + RUBG_WIN_HP); log(`❤️ +${RUBG_WIN_HP}% HP — полоска ${Math.round(p.hp)}%`); }
        if (map.winMin) { p.secLeft += map.winMin * 60; }
        if (map.winTries) { p.triesLeft += map.winTries; }
        /* Боссы на этой ячейке ПОБЕЖДЕНЫ ЭТИМ ИГРОКОМ (у каждого свой прогресс — босс жив, пока не пал от его руки) */
        for (const b of map.bosses ?? []) {
          const bi = cellAtPoint(map, b.x, b.y);
          if (bi !== a.cellIdx) continue;
          s.qBossDown = s.qBossDown ?? {};
          const lst = s.qBossDown[p.id] ?? [];
          if (!lst.includes(b.id)) lst.push(b.id);
          s.qBossDown[p.id] = lst;
          const bdef = (map.bossLib ?? []).find((x) => x.id === b.bid);
          const dms = bdef ? clipMs(bdef.defeated) : 0;
          if (bdef && dms) pushFx({ kind: 'bossDef', player: p.id, cellIdx: a.cellIdx, bossId: b.id, ms: dms, after: 'none' });
          if (bdef) log(`👹 Босс «${bdef.name}» ПОБЕЖДЕН игроком ${p.name}!`);
        }
        const tkw = cellTaskOf(s, map, a.cellIdx);
        log(`🏆 ${p.name} ПРОШЁЛ задание «${(tkw?.title ?? `№${a.cellIdx + 1}`).slice(0, 30)}» — всего выполнено: ${done.length}`);
      } else {
        s.qFails = s.qFails ?? {};
        s.qFails[p.id] = (s.qFails[p.id] ?? 0) + 1;
        if (resM === 'coins') {
          const sc = Math.max(0, Math.floor(map.skipCoins ?? SKIP_COINS_DEFAULT));
          if (sc > 0) { p.coinsLeft = Math.max(0, (p.coinsLeft ?? 0) - sc); log(`🪙 Плата за поражение: −${sc} бронзы — капитал ${coinsStr(p.coinsLeft)}`); }
        }
        if (resM === 'hp') { p.hp = Math.max(0, (p.hp ?? RUBG_HP_MAX) - RUBG_LOSE_HP); log(`💔 −${RUBG_LOSE_HP}% HP — полоска ${Math.round(p.hp)}%`); }
        log(`💢 ${p.name} проиграл задание №${a.cellIdx + 1}${failsLimitText(map) ? ` (провалов: ${s.qFails[p.id]}${failsLimitText(map)})` : ''}`);
      }
      checkElim();
      break;
    }
    case 'qJobLeave': {
      if (!isQuestMode(map.mode)) break;
      const p = actor();
      const job = p ? s.qJobs?.[p.id] : undefined;
      if (!p || !job || job.cellIdx !== a.cellIdx) break;
      delete s.qJobs![p.id];
      log(`🚶 ${p.name} отошёл от задания — можно зайти снова`);
      break;
    }
    case 'qCardAck': {
      const p = actor();
      if (!p) break;
      if (s.qCards?.[p.id]) delete s.qCards[p.id];
      break;
    }
    case 'dialogPick': {
      if (s.phase !== 'playing') break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const npc = (map.npcs ?? []).find((x) => x.id === a.npcId);
      const node = npc?.dialog?.nodes.find((n) => n.id === a.nodeId);
      const opt = node?.opts?.[Math.floor(a.optIdx)];
      if (!npc || !node || !opt) break;
      const flags = s.qFlags = s.qFlags ?? {};
      const mine = flags[p.id] = flags[p.id] ?? {};
      if (opt.reqFlag && !mine[opt.reqFlag]) break; // вариант недоступен без флага
      if (opt.reqNotFlag && mine[opt.reqNotFlag]) break;
      if (opt.give) giveReward(p, opt.give, 'награда от NPC');
      if (opt.setFlag) mine[opt.setFlag] = true;
      if (opt.ending) {
        const e = (map.endings ?? []).find((x) => x.id === opt.ending);
        if (e) {
          if (!e.goal || e.goal.kind === 'none') {
            /* концовка БЕЗ условия: выбор в диалоге немедленно завершает игру победой */
            s.phase = 'over';
            s.winner = p.id;
            s.ending = { playerId: p.id, endingId: e.id };
            log(`🎬 ${p.name} сделал финальный выбор — КОНЦОВКА «${e.name}»!`);
            break;
          }
          mine[`ending:${e.id}`] = true;
          log(`🎬 ${p.name} выбрал путь концовки «${e.name}»: ${questGoalText(e.goal, map)}`);
        }
      }
      checkElim();
      break;
    }
    case 'npcClaim': {
      if (s.phase !== 'playing') break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const npc = (map.npcs ?? []).find((x) => x.id === a.npcId);
      const q = npc?.quests?.find((x) => x.id === a.questId);
      if (!npc || !q) break;
      const flags = s.qFlags = s.qFlags ?? {};
      const mine = flags[p.id] = flags[p.id] ?? {};
      if (mine[`quest:${q.id}`]) break; // уже сдан
      if (!questGoalsDone(p, q.goal)) { log(`⏳ Квест «${q.title}» ещё не выполнен: ${questGoalText(q.goal, map)}`); break; }
      mine[`quest:${q.id}`] = true;
      giveReward(p, q.reward, `квест «${q.title}» сдан`);
      /* Снятие стен: выполненный квест убирает назначенные ему стены — путь открыт ВСЕМ */
      if (q.removeWalls?.length) {
        const ids = (map.walls ?? []).map((w) => w.id).filter((id): id is string => !!id && q.removeWalls!.includes(id));
        const before = s.wallsRemoved ?? [];
        s.wallsRemoved = [...new Set([...before, ...ids])];
        if (s.wallsRemoved.length > before.length) log(`🧱 Стены ИСЧЕЗЛИ (${s.wallsRemoved.length - before.length} шт.) — путь открыт!`);
      }
      const left = (npc.quests ?? []).filter((x) => !mine[`quest:${x.id}`]).length;
      const npcName = (map.npcLib ?? []).find((x) => x.id === npc.nid)?.name ?? '?';
      if (!left) log(`🗣 NPC «${npcName}»: все его квесты выполнены ${p.name}!`);
      checkElim();
      break;
    }
    case 'rubgUseItem': {
      if (map.mode !== 'rubg' || !s.rubg) break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const inv = p.items ?? (p.items = []);
      const ii = inv.findIndex((x) => x.id === a.itemId);
      if (ii < 0) break;
      const meta = RUBG_ITEMS[inv[ii].kind];
      if (meta.hp <= 0 || meta.radius > 0) break; // только хилки
      if (!inv[ii].belt) break; // использовать можно только с ПОЯСА (общий инвентарь — склад: наденьте на пояс)
      if ((p.hp ?? 0) >= RUBG_HP_MAX) break; // полоска полна
      inv.splice(ii, 1);
      p.hp = Math.min(RUBG_HP_MAX, (p.hp ?? 0) + meta.hp);
      log(`${meta.icon} ${p.name} использует «${meta.name}»: +${meta.hp}% HP — HP ${p.hp}%`);
      break;
    }
    case 'rubgShoot': {
      if (s.phase !== 'playing' || map.mode !== 'rubg' || !s.rubg) break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const rg = s.rubg;
      const inv = p.items ?? (p.items = []);
      const ii = inv.findIndex((x) => x.id === a.itemId);
      if (ii < 0) break;
      const kind = inv[ii].kind;
      const meta = RUBG_ITEMS[kind];
      if (meta.radius <= 0) break; // не оружие
      if (!inv[ii].belt) break; // стрелять можно только с ПОЯСА (общий инвентарь — склад: наденьте на пояс)
      const target = s.players.find((x) => x.id === a.targetId);
      if (!target || !target.alive || target.spect || target.id === p.id) break;
      if ((rg.stealth ?? []).includes(target.id)) break; // в стелсе не видно — стрелять нельзя
      const tp = playerPx(s, map, target.id);
      const mp = playerPx(s, map, p.id);
      if (!tp || !mp) break;
      const dist = Math.hypot(tp.x - mp.x, tp.y - mp.y);
      const range = meta.radius * CELL_PX;
      if (dist > range) break; // вне радиуса оружия
      /* ЛЕТЯЩАЯ ПУЛЯ: запись выстрела видят ВСЕ — каждый клиент рисует трассер
         от стрелка к цели и включает звук (пистолет/ПП/снайперка звучат по-разному) */
      rg.shots = [
        ...(rg.shots ?? []).filter((x) => Date.now() - x.ts < 2000),
        { id: 'sh' + Math.random().toString(36).slice(2, 9), from: p.id, to: target.id, kind, ts: Date.now() },
      ];
      /* по цели в ЛИЧНОМ задании — 100% попадание; по ходячей — шанс от расстояния */
      const busy = !!(rg.jobs ?? {})[target.id];
      const hit = busy ? true : Math.random() < Math.max(0.15, 1 - dist / range);
      inv.splice(ii, 1); // оружие одноразовое
      p.stealth = false; // выстрел раскрывает
      rg.stealth = (rg.stealth ?? []).filter((x) => x !== p.id);
      if (hit) {
        target.hp = Math.max(0, (target.hp ?? RUBG_HP_MAX) - meta.hp);
        log(`${meta.icon} ${p.name} ПОПАЛ по ${target.name} (${meta.name}, ${Math.round(dist / CELL_PX)} кл): −${meta.hp}% HP — у цели ${target.hp}%${busy ? ' (играл в задание — 100%)' : ''}`);
      } else {
        log(`💨 ${p.name} промахнулся по ${target.name} (${meta.name}, ${Math.round(dist / CELL_PX)} кл)`);
      }
      checkElim();
      break;
    }
    /* ---------- ЯЩИКИ С ЛУТОМ (вместо «пройти мимо и забрать»): взлом ОТМЫЧКОЙ
       (мини-игра «замок» у клиента, хост выдаёт лут) или СИЛОЙ (25%, провал — бан ящика).
       Подход к ящику обязателен: проверяем расстояние до прямоугольника ячейки. ---------- */
    case 'rubgBoxHack':
    case 'rubgBoxBreak':
    case 'rubgBoxForce': {
      if (s.phase !== 'playing' || map.mode !== 'rubg' || !s.rubg) break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const rg = s.rubg;
      rg.looted = rg.looted ?? [];
      rg.boxBan = rg.boxBan ?? {};
      const cell = map.cells[a.cellIdx];
      if (!cell || cell.type !== 'loot') break;
      if (rg.looted.includes(a.cellIdx)) break; // уже вскрыт
      if ((rg.boxBan[p.id] ?? []).includes(a.cellIdx)) break; // провалил силой — закрыт навсегда
      const pp = playerPx(s, map, p.id);
      const r = cellRectOf(map, a.cellIdx);
      if (!pp || !r) break;
      const ddx = Math.max(r.x - pp.x, 0, pp.x - (r.x + r.w));
      const ddy = Math.max(r.y - pp.y, 0, pp.y - (r.y + r.h));
      if (Math.hypot(ddx, ddy) > CELL_PX * 2) break; // далеко от ящика (запас 2 клетки — на пинг)
      if (a.t === 'rubgBoxForce') {
        /* ОТКРЫТЬ СИЛОЙ: шанс 25%. Провал — ящик для этого игрока закрыт НАВСЕГДА
           (и отмычкой, и силой): ломать замок грубой силой больше не выйдет */
        if (Math.random() < 0.25) {
          rg.looted.push(a.cellIdx);
          const kind = rubgRandomKind();
          rubgGiveItem(p, kind);
          const meta = RUBG_ITEMS[kind];
          log(`💥 ${p.name} ВЫЛОМАЛ ЯЩИК №${a.cellIdx + 1} СИЛОЙ: ${meta.icon} ${meta.name}${kind === 'steal' ? ' (3 исп.)' : ''}`);
        } else {
          if (!rg.boxBan[p.id]) rg.boxBan[p.id] = [];
          if (!rg.boxBan[p.id].includes(a.cellIdx)) rg.boxBan[p.id].push(a.cellIdx);
          log(`💥 ${p.name} не смог выломать ЯЩИК №${a.cellIdx + 1} — замок заклинило НАВСЕГДА, этот ящик для него закрыт`);
        }
        break;
      }
      /* взлом отмычкой: предмет должен быть отмычкой НА ПОЯСЕ у игрока */
      const inv = p.items ?? (p.items = []);
      const ii = inv.findIndex((x) => x.id === a.itemId);
      if (ii < 0) break;
      if (inv[ii].kind !== 'lockpick') break;
      if (!inv[ii].belt) break; // только поясная отмычка взламывает
      if (a.t === 'rubgBoxBreak') {
        /* промах фиксации: отмычка СЛОМАНА — уходит в никуда, ящик остаётся закрытым */
        inv.splice(ii, 1);
        log(`🔓 ${p.name} СЛОМАЛ отмычку о замок ЯЩИКА №${a.cellIdx + 1} — нужна новая (ящики и победы в заданиях её дают)`);
        break;
      }
      /* успех мини-игры: отмычка сгорает, из ящика — случайный предмет */
      inv.splice(ii, 1);
      rg.looted.push(a.cellIdx);
      const kind = rubgRandomKind();
      rubgGiveItem(p, kind);
      const meta = RUBG_ITEMS[kind];
      rg.stealth = (rg.stealth ?? []).filter((xid) => xid !== p.id);
      p.stealth = false;
      log(`🔓 ${p.name} ВЗЛОМАЛ ЯЩИК №${a.cellIdx + 1} отмычкой: ${meta.icon} ${meta.name}${kind === 'steal' ? ' (3 исп.)' : ''}`);
      break;
    }
    case 'rubgStealStart': {
      if (s.phase !== 'playing' || map.mode !== 'rubg' || !s.rubg) break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const rg = s.rubg;
      rg.jobs = rg.jobs ?? {}; rg.steals = rg.steals ?? {};
      const victim = s.players.find((x) => x.id === a.victimId);
      if (!victim || !victim.alive || victim.id === p.id) break;
      if (!rg.jobs[victim.id]) break; // красть можно только у играющего в задание
      if (rg.steals[victim.id]) break; // у этой жертвы уже воруются
      const vp = playerPx(s, map, victim.id);
      const mp = playerPx(s, map, p.id);
      if (!vp || !mp) break;
      if (Math.hypot(vp.x - mp.x, vp.y - mp.y) > RUBG_STEAL_RANGE * CELL_PX) break; // нужно подойти ВПЛОТНУЮ
      const card = (p.items ?? []).find((x) => x.kind === 'steal' && (x.uses ?? 0) > 0);
      if (!card) break; // карты воровства нет
      /* чем дольше держал кнопку — тем больше время в кармане. БЕЗ ВЕРХНЕГО ЛИМИТА:
         сколько удержал — столько и получил (окантовка-часы крутится дальше каждый круг) */
      const dur = Math.max(1, Math.max(0, a.holdMs) / 1000);
      rg.steals[victim.id] = { thief: p.id, victim: victim.id, dur, startedAt: Date.now() };
      log(`🤏 ${p.name} запускает руку в карман ${victim.name} (${dur >= 90 ? `${Math.round(dur / 60)} мин` : `${dur.toFixed(1)} с`})!`);
      break;
    }
    case 'rubgStealPick': {
      if (map.mode !== 'rubg' || !s.rubg) break;
      const rg = s.rubg;
      rg.steals = rg.steals ?? {};
      const st = rg.steals[a.victimId];
      if (!st || st.thief !== a.id) break;
      if (Date.now() - st.startedAt > st.dur * 1000 + 700) break; // время вышло
      const thief = s.players.find((x) => x.id === st.thief);
      const victim = s.players.find((x) => x.id === st.victim);
      if (!thief || !victim) break;
      const vinv = victim.items ?? (victim.items = []);
      const ii = vinv.findIndex((x) => x.id === a.itemId);
      if (ii < 0) break;
      if (vinv[ii].belt) break; // предметы на ПОЯСЕ не воруются — только из общего инвентаря
      const [stolen] = vinv.splice(ii, 1);
      /* крадёное: на пояс вора, если есть свободный слот (макс. 3), иначе в общий инвентарь */
      stolen.belt = (thief.items ?? []).filter((x) => x.belt).length < RUBG_BELT_SLOTS;
      (thief.items ?? (thief.items = [])).push(stolen);
      /* карта воровства: −1 использование (3 всего); в 0 — сгорела */
      const card = (thief.items ?? []).find((x) => x.kind === 'steal' && (x.uses ?? 0) > 0);
      if (card) {
        card.uses = (card.uses ?? 1) - 1;
        if ((card.uses ?? 0) <= 0) thief.items = (thief.items ?? []).filter((x) => x.id !== card.id);
      }
      delete rg.steals[a.victimId];
      const meta = RUBG_ITEMS[stolen.kind];
      log(`🤏 ${thief.name} ВЫТАЩИЛ из кармана ${victim.name}: ${meta.icon} ${meta.name}!`);
      break;
    }
    case 'rubgStealFail': {
      if (map.mode !== 'rubg' || !s.rubg) break;
      const rg = s.rubg;
      rg.steals = rg.steals ?? {}; rg.stealth = rg.stealth ?? [];
      const st = rg.steals[a.victimId];
      if (!st || st.thief !== a.id) break;
      delete rg.steals[a.victimId];
      const thief = s.players.find((x) => x.id === st.thief);
      if (thief) {
        thief.stealth = false; // неудачная попытка раскрывает
        rg.stealth = rg.stealth.filter((x) => x !== thief.id);
      }
      log(`💨 Кража у ${s.players.find((x) => x.id === a.victimId)?.name ?? '?'} провалилась — вор раскрыт`);
      break;
    }
    case 'rubgStopThief': {
      if (map.mode !== 'rubg' || !s.rubg) break;
      const p = actor();
      if (!p || !p.alive) break;
      const rg = s.rubg;
      rg.steals = rg.steals ?? {}; rg.stopCd = rg.stopCd ?? {}; rg.stealth = rg.stealth ?? [];
      const now = Date.now();
      const last = rg.stopCd[p.id] ?? 0;
      if (now - last < RUBG_STOP_CD * 1000) break; // анти-спам: 15 с между нажатиями
      rg.stopCd[p.id] = now;
      const st = rg.steals[p.id];
      if (st) {
        delete rg.steals[p.id];
        const thief = s.players.find((x) => x.id === st.thief);
        if (thief) {
          thief.stealth = false;
          rg.stealth = rg.stealth.filter((x) => x !== thief.id);
        }
        log(`🚨 ${p.name} ПОЙМАЛ вора за руку (${thief?.name ?? '?'}) — кража сорвана!`);
      } else {
        log(`✋ ${p.name} проверил карманы — вора не было`);
      }
      break;
    }
    case 'rubgStealth': {
      if (map.mode !== 'rubg' || !s.rubg) break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const rg = s.rubg;
      rg.stealth = rg.stealth ?? [];
      if (rg.stealth.includes(p.id)) break; // уже в стелсе
      const inv = p.items ?? (p.items = []);
      const ci = inv.findIndex((x) => x.kind === 'stealth');
      if (ci < 0) break; // карты стелса нет
      if (!inv[ci].belt) break; // активировать можно только с ПОЯСА (общий инвентарь — склад)
      inv.splice(ci, 1);
      p.stealth = true;
      rg.stealth.push(p.id);
      log(`👻 ${p.name} РАСТВОРИЛСЯ в стелсе — выйдет при входе в ячейку, подборе, выстреле или неудачной краже`);
      break;
    }
    case 'rubgBelt': {
      /* ПОЯС: надеть/снять предмет. На поясе максимум RUBG_BELT_SLOTS (3) предмета —
         только они показаны на экране и имеют кнопки действий (лечиться/стрелять/
         воровать/стелс — только с пояса); остальное лежит в общем инвентаре
         (кнопка «Инвентарь»). Предметы на поясе НЕ воруются. */
      if (map.mode !== 'rubg' || !s.rubg) break;
      const p = actor();
      if (!p || !p.alive || p.spect) break;
      const inv = p.items ?? (p.items = []);
      const it = inv.find((x) => x.id === a.itemId);
      if (!it) break;
      if (a.on) {
        if (it.belt) break; // уже на поясе
        if (inv.filter((x) => x.belt).length >= RUBG_BELT_SLOTS) break; // пояс полон — снимите что-нибудь
        it.belt = true;
        log(`🧰 ${p.name} надевает «${RUBG_ITEMS[it.kind].name}» на пояс`);
      } else {
        it.belt = false;
        log(`🎒 ${p.name} убирает «${RUBG_ITEMS[it.kind].name}» в инвентарь`);
      }
      break;
    }
    case 'chooseMode': {
      const ch = s.challenge;
      const p = current();
      if (!ch || ch.status !== 'choose' || p.id !== a.id) break;
      // с нулём ресурса выбирать его нельзя (монеты можно — ими платят по итогам)
      if (a.mode === 'time' && p.secLeft <= 0) break;
      if (a.mode === 'tries' && p.triesLeft <= 0) break;
      if (a.mode === 'coins' && map.startCoins === undefined) break;
      /* ОДИН РЕСУРС (мастер челленджа): «время» недоступно при ресурсе «попытки» и наоборот */
      const resM = map.resMode ?? 'std';
      if (a.mode === 'time' && resM === 'tries') break;
      if (a.mode === 'tries' && resM === 'time') break;
      ch.mode = a.mode;
      // пакость «Штраф ×2» удваивает цену пропуска
      const need = SKIP_COST * (cellTaskOf(s, map, ch.cellIdx)?.chaos === 'skipX2' ? 2 : 1);
      // если ресурса меньше цены пропуска — пропуск станет доступен только на нуле
      const remaining = a.mode === 'time' ? Math.floor(p.secLeft / 60) : a.mode === 'tries' ? p.triesLeft : Math.max(0, (p.coinsLeft ?? 0) - Math.max(0, Math.floor(map.skipCoins ?? SKIP_COINS_DEFAULT)));
      ch.lowStart = a.mode !== 'coins' && remaining < need;
      ch.status = 'ready'; // выбран ресурс, но запуск — по команде игрока
      log(`${p.name}: ${a.mode === 'time' ? 'играет на ВРЕМЯ ⏱' : a.mode === 'tries' ? 'играет на ПОПЫТКИ 🎯' : 'играет на МОНЕТЫ 🪙 — платёж по итогам'}`);
      break;
    }
    case 'startTask': {
      const ch = s.challenge;
      const p = current();
      if (!ch || ch.status !== 'ready' || ch.started || p.id !== a.id) break;
      ch.started = true;
      ch.paused = false;
      ch.status = 'playing';
      if (ch.mode === 'tries') {
        ch.loads = 1;
        ch.reloadId++;
      } else if (ch.mode === 'time') {
        ch.startedAt = Date.now();
        ch.accMs = 0;
      } // монеты/HP: во время игры ничего не тратится — платёж только по итогам
      log(`▶ ${p.name} запускает задание${ch.mode === 'tries' ? ' — попытка №1' : ch.mode === 'time' ? ' — таймер пошёл' : ch.mode === 'hp' ? ' — HP-режим: +10% за победу / −5% за поражение' : ' — монетная игра'}`);
      break;
    }
    case 'togglePause': {
      const ch = s.challenge;
      const p = current();
      if (!ch || ch.status !== 'playing' || !ch.started || p.id !== a.id) break;
      if (ch.paused) {
        ch.paused = false;
        if (ch.mode === 'time') ch.startedAt = Date.now();
        log(`▶ ${p.name} продолжает задание`);
      } else {
        if (ch.mode === 'time' && ch.startedAt > 0) ch.accMs += Date.now() - ch.startedAt;
        ch.paused = true;
        log(`⏸ ${p.name}: пауза${ch.mode === 'time' ? ' — таймер остановлен' : ''}`);
      }
      break;
    }
    case 'token': {
      const p = s.players.find((x) => x.id === a.id);
      if (!p || (s.phase !== 'lobby' && s.phase !== 'rollOff')) break;
      if (a.tokenId !== undefined) {
        /* фишка из набора карты (mapTokens): уникальна на партию —
           если её уже взял другой игрок, повторно взять не выйдет */
        const tok = (map.mapTokens ?? []).find((t) => t.id === a.tokenId);
        if (!tok) break;
        if (s.players.some((x) => x.id !== a.id && x.tokenKey === tok.id)) break;
        p.tokenKey = tok.id;
        p.tokenImg = tok.dataUrl;
        p.tokenSize = tok.size ?? (tok.anim ? 64 : 34);
        log(`♟ ${p.name} берёт фишку «${tok.name}»`);
      } else {
        p.tokenKey = undefined;
        p.tokenImg = a.tokenImg;
        p.tokenSize = a.tokenSize;
      }
      break;
    }
    case 'reloadSave': {
      const ch = s.challenge;
      const p = current();
      if (!ch || ch.status !== 'playing' || p.id !== a.id) break;
      // МОНЕТЫ/HP: перезапуски бесплатны и не ограничены — платёж только по итогам
      if (ch.mode === 'coins' || ch.mode === 'hp') {
        ch.reloadId++;
        if (ch.paused) ch.paused = false;
        log(`↻ ${p.name}: перезапуск задания (${ch.mode === 'hp' ? 'HP — без списаний' : 'монеты — без списаний'})`);
        break;
      }
      // при нуле ресурса перезапускать нечего: в попытках каждая загрузка стоит попытку,
      // во времени — время уже вышло, задание непроходимо. Единственный путь — «Пропустить».
      {
        const nowMs = Date.now();
        const running = ch.mode === 'time' && ch.started && !ch.paused && ch.startedAt > 0;
        const msSpent = ch.accMs + (running ? nowMs - ch.startedAt : 0);
        if (ch.mode === 'tries' && p.triesLeft - ch.loads <= 0) break;
        if (ch.mode === 'time' && p.secLeft * 1000 - msSpent <= 0) break;
      }
      if (ch.mode === 'tries') ch.loads++;
      ch.reloadId++;
      if (ch.paused) {
        ch.paused = false;
        if (ch.mode === 'time') ch.startedAt = Date.now();
      }
      if (ch.mode === 'tries') log(`↻ ${p.name}: перезапуск задания — попытка №${ch.loads}`);
      else log(`↻ ${p.name}: перезапуск задания`);
      break;
    }
    case 'declareDone': {
      const ch = s.challenge;
      const p = current();
      if (!ch || ch.status !== 'playing' || p.id !== a.id) break;
      if (othersCount() === 0) {
        challengeSuccess();
        break;
      }
      ch.status = 'voting';
      ch.approvals = [p.id];
      ch.violations = [];
      log(`✋ ${p.name}: «Задание выполнено!» — нужно подтверждение`);
      break;
    }
    case 'approve': {
      const ch = s.challenge;
      if (!ch || ch.status !== 'voting' || ch.approvals.includes(a.id) || a.id === current().id) break;
      ch.approvals.push(a.id);
      log(`${actor()?.name ?? '?'}: согласен ✔`);
      if (ch.approvals.length >= alive().length) challengeSuccess();
      break;
    }
    case 'violate': {
      const ch = s.challenge;
      const p = current();
      if (!ch || (ch.status !== 'voting' && ch.status !== 'playing') || ch.violations.includes(a.id) || a.id === p.id) break;
      ch.violations.push(a.id);
      log(`${actor()?.name ?? '?'}: «НАРУШЕНИЕ!» ✖`);
      if (ch.violations.length >= othersCount()) {
        ch.status = 'playing';
        ch.approvals = [];
        ch.violations = [];
        ch.reloadId++;
        if (ch.mode === 'tries') ch.loads++;
        log(opts.autoReloadOnViolation
          ? `⚠ Нарушение доказано — сохранение перезагружено автоматически`
          : `⚠ Нарушение доказано — ${p.name} перезагружает сохранение вручную`);
      }
      break;
    }
    case 'skip': {
      const ch = s.challenge;
      const p = current();
      if (!ch || p.id !== a.id) break;

      /* МОНЕТЫ: пропуск платой в бронзе (цена — map.skipCoins, 0 = бесплатно);
         при нулевом капитале пропуск разрешён свободно — игрок всё равно банкрот
         (в coinsOnly checkElim его выбьет, в смешанном он просто без монет) */
      if (ch.mode === 'coins' || (a.instant && a.resource === 'coins')) {
        const needC = Math.max(0, Math.floor(map.skipCoins ?? SKIP_COINS_DEFAULT));
        const have = p.coinsLeft ?? 0;
        if (have > 0 && have < needC) break; // монет не хватает на плату — играйте, побеждайте и зарабатывайте
        finishChallenge(false, 0, 0);
        checkElim();
        break;
      }

      /* HP-РЕЖИМ: пропуск = поражение — стоит −5% полоски HP, доступен всегда */
      if (ch.mode === 'hp') {
        finishChallenge(false, 0, 0);
        checkElim();
        break;
      }

      // пакость «Штраф ×2»: цена пропуска удваивается
      const need = SKIP_COST * (cellTaskOf(s, map, ch.cellIdx)?.chaos === 'skipX2' ? 2 : 1);

      // правило: если на старте ресурса было меньше цены — пропуск разрешён только при нуле.
      // Нуль считаем по ОСТАТКУ (хранящийся ресурс минус потраченное в этом задании):
      // хранящиеся secLeft/triesLeft во время задания не меняются — списываются только в конце.
      const nowMs = Date.now();
      const running = ch.mode === 'time' && ch.started && !ch.paused && ch.startedAt > 0;
      const ms = ch.accMs + (running ? nowMs - ch.startedAt : 0);
      if (ch.mode && ch.lowStart) {
        const rem = ch.mode === 'time'
          ? p.secLeft * 1000 - ms
          : p.triesLeft - ch.loads;
        if (rem > 0) break;
      }
      // обычный пропуск требует потратить цену пропуска (5, а при «Штраф ×2» — 10)
      if (ch.mode && !a.instant) {
        const units = ch.mode === 'time' ? Math.floor(ms / 60000) : ch.loads;
        if (!ch.lowStart && units < need) break;
      }

      // если уже потрачено нужное количество ресурсов — платить «авансом» нельзя (только фактическую цену)
      const unitsSpent = ch.mode === 'time' ? Math.floor(ms / 60000) : ch.loads;
      if (a.instant && !ch.lowStart && unitsSpent >= need) break;

      if (ch.mode === 'time' && !a.instant) {
        const cost = Math.max(1, Math.ceil(ms / 60000));
        finishChallenge(false, Math.min(cost, Math.max(1, Math.floor(p.secLeft / 60))) * 60, 0);
      } else if (ch.mode === 'tries' && !a.instant) {
        const cost = Math.max(ch.loads, need);
        finishChallenge(false, 0, Math.min(cost, Math.max(1, p.triesLeft)));
      } else if (a.instant && a.resource === 'time') {
        // мгновенный пропуск за цену пропуска в минутах (или сколько осталось)
        finishChallenge(false, Math.min(need, Math.floor(p.secLeft / 60)) * 60, 0);
      } else if (a.instant && a.resource === 'tries') {
        // мгновенный пропуск за цену пропуска в попытках (или сколько осталось)
        finishChallenge(false, 0, Math.min(need, Math.max(1, p.triesLeft)));
      } else {
        // мгновенный пропуск в выбранном режиме
        if (ch.mode === 'time') finishChallenge(false, Math.min(need, Math.floor(p.secLeft / 60)) * 60, 0);
        else finishChallenge(false, 0, Math.min(need, Math.max(1, p.triesLeft)));
      }
      checkElim();
      break;
    }
    case 'immuneSkip': {
      // радость-иммунитет: пропуск задания БЕЗ платы, карточка сгорает
      const ch = s.challenge;
      const p = actor();
      if (!ch || s.phase !== 'playing' || !p || p.id !== a.id || p.id !== current().id) break;
      const want: JoyId = a.emu === 'nes' ? 'joy-immuneNes' : a.emu === 'sega' ? 'joy-immuneSega' : 'joy-joker';
      const meta = JOY_LIST.find((j) => j.id === want)!;
      const inv = p.inventory ?? (p.inventory = []);
      const ci = inv.findIndex((c) => c.id === want);
      if (ci < 0) break;
      if ((s.trades ?? []).some((x) => (x.status === 'pending' || x.status === 'countered') && x.cardId === want)) {
        log('✖ Карточка зарезервирована сделкой');
        break;
      }
      inv.splice(ci, 1);
      log(`🛡 ${p.name} использует «${meta.name}» — задание пропущено без платы`);
      finishChallenge(false, 0, 0);
      checkElim();
      break;
    }
    case 'postChoice': {
      const p = current();
      if (!s.awaitPost || p.id !== a.id) break;
      if (gatingFx()) break; // ждём окончания анимации победы
      s.awaitPost = false;
      if (a.choice === 'end') endTurnNow();
      else log(`${p.name} продолжает ход`);
      break;
    }
    case 'setCellTask': {
      const p = current();
      if (!s.awaitPost || p.id !== a.id) break;
      if (gatingFx()) break; // ждём окончания анимации победы
      if (map.mode === 'skill') {
        log('✖ В SKILL CHALLENGE своё задание не создаётся — вы играете один и сражаетесь только с собой');
        break;
      }
      const task: TaskDef = { ...a.task };
      // пакость из инвентаря: тратим карточку — следующий играющий на этой ячейке получит искажения
      if (a.cardId) {
        const inv = p.inventory ?? (p.inventory = []);
        const ci = inv.findIndex((c) => c.id === a.cardId);
        if (ci >= 0 && inv[ci].chaos && !(s.trades ?? []).some((x) => (x.status === 'pending' || x.status === 'countered') && x.cardId === a.cardId)) {
          const [card] = inv.splice(ci, 1);
          task.chaos = card.chaos;
          log(`😈 ${p.name} добавляет пакость «${card.name}» к заданию на ячейке №${a.cellIdx + 1}`);
        }
      }
      /* Задание вступает в силу через 3 ХОДА любого игрока: до тех пор ячейка
         остаётся разбитой и пустой (хозяин — победитель). */
      s.broken = s.broken ?? {};
      s.broken[a.cellIdx] = { by: p.id, left: 3, task };
      /* Боссы, стоящие на этой ячейке, ПОВЕРЖЕНЫ: ОДИН раз играется клип гибели
         (defeated, со своим звуком), потом босс навсегда замирает на его последнем кадре.
         У старых боссов без клипа гибели — как раньше: замирает на последнем кадре win. */
      for (const b of map.bosses ?? []) {
        if (s.bossDown?.[b.id]) continue;
        const bi = cellAtPoint(map, b.x, b.y);
        if (bi !== a.cellIdx) continue;
        s.bossDown = s.bossDown ?? {};
        s.bossDown[b.id] = true;
        const bdef = (map.bossLib ?? []).find((x) => x.id === b.bid);
        const dms = bdef ? clipMs(bdef.defeated) : 0;
        if (bdef && dms) {
          /* гибель босса — тоже спектакль: клип со звуком, ход уходит следующему
             игроку только после него (fxDone/страховка) */
          pushFx({ kind: 'bossDef', player: p.id, cellIdx: a.cellIdx, bossId: b.id, ms: dms, gate: true, after: 'endTurn' });
        }
        if (bdef) log(`👹 Босс «${bdef.name}» ПОВЕРЖЕН${dms ? ' — гибнет' : ' — замер побеждённым'}`);
      }
      s.awaitPost = false;
      log(`🛠 ${p.name} создаёт задание на ячейке №${a.cellIdx + 1} — вступит в силу через 3 хода (доп. ход сгорает)`);
      if (!gatingFx()) endTurnNow(); // есть клип гибели босса — ход уйдёт после него (fxDone)
      break;
    }
    case 'useCard': {
      // применить карточку из инвентаря на себя: только в свой ход,
      // когда на столе пусто (до броска кубиков)
      if (s.phase !== 'playing') break;
      if (map.mode === 'journey') { log('✖ В JOURNEY карточки не действуют — игроки ходят напрямую'); break; }
      if (isQuestMode(map.mode)) { log('✖ В QUEST карточки из инвентаря не применяются — игра индивидуальная'); break; }
      if (gatingFx()) break; // идёт анимация победы/поражения — ждём её
      const p = actor();
      if (!p || !p.alive || p.id !== current().id) break;
      if (s.moving || s.challenge || s.pendingCard || s.quiz || s.awaitPost) break;
      const inv = p.inventory ?? (p.inventory = []);
      const ci = inv.findIndex((c) => c.id === a.cardId);
      if (ci < 0) break;
      const card = inv[ci];
      if (card.chaos) break; // пакости не «применяют» — они клеятся к своему заданию или продаются
      if (card.effect.type === 'immuneSega' || card.effect.type === 'immuneNes') {
        log(`🛡 «${card.name}» сработает сама — когда встанете на задание нужной консоли`);
        break;
      }
      if (openTradeOfCard(card.id)) { log('✖ Карточка зарезервирована сделкой'); break; }
      // радости: не больше одной на ход
      if (card.kind === 'joy') {
        if ((p.joyTurn ?? -1) === (s.turnNo ?? 1)) { log('✖ Одна радость на ход — уже использована'); break; }
        if (card.effect.type === 'diePlus') {
          if (p.oneDie) { log('😈 Один кубик: «+1 кубик» сейчас не действует'); break; }
          const tCur = cellTaskOf(s, map, p.pos);
          if (tCur?.chaos === 'dice0' && s.captured[p.pos] !== p.id) { log('😈 Кубики-0: бросок всё равно будет нулевым'); break; }
          if (p.dicePlus) { log('✖ «+1 кубик» уже активен'); break; }
        }
      }
      inv.splice(ci, 1);
      if (card.kind === 'joy') p.joyTurn = s.turnNo ?? 1;
      log(`🎴 ${p.name} применяет карточку «${card.name}»`);
      applyCard(p, card);
      checkElim();
      break;
    }
    case 'tradeOffer': {
      if (s.phase !== 'playing') break;
      if (map.mode === 'journey') { log('✖ В JOURNEY торги недоступны'); break; }
      if (isQuestMode(map.mode)) { log('✖ В QUEST торги недоступны — каждый играет сам за себя'); break; }
      const p = actor();
      if (!p || !p.alive) break;
      // торгуются те, кто сейчас не в процессе хода; текущий игрок — только ДО броска
      // кубиков (пока !moving && !challenge && !pendingCard && !quiz && !awaitPost)
      const turnBusy = !!(s.moving || s.challenge || s.pendingCard || s.quiz || s.awaitPost || gatingFx());
      if (p.id === current().id && turnBusy) { log('✖ Ход уже начался — торговать нельзя (торги открыты до броска кубиков)'); break; }
      const buyer = s.players.find((x) => x.id === (a as { to?: string }).to && x.alive);
      if (!buyer || buyer.id === p.id) break;
      if (buyer.id === current().id && turnBusy) { log(`✖ Нельзя предлагать сделку ${buyer.name} — его ход уже начался`); break; }
      const min = Math.max(0, Math.min(90, Math.floor((a as { priceMin?: number }).priceMin ?? 0)));
      const tries = Math.max(0, Math.min(90, Math.floor((a as { priceTries?: number }).priceTries ?? 0)));
      if (min + tries <= 0) { log('✖ Цена не может быть нулевой'); break; }
      const cellIdx = (a as { cellIdx?: number }).cellIdx;
      if (cellIdx !== undefined && cellIdx !== null) {
        // продажа ячейки: только своя, не на ней задания сейчас, не в сделке
        if (map.mode === 'rubg') { log('✖ В RUBG побеждённые ячейки НЕ ПРОДАЮТСЯ — они остаются за победителем до конца партии'); break; }
        const idx = Math.floor(cellIdx);
        if (s.captured[idx] !== p.id) { log('✖ Продаётся только своя ячейка'); break; }
        if (s.challenge?.cellIdx === idx) { log('✖ На этой ячейке сейчас идёт задание'); break; }
        if (openTradeOfCell(idx)) { log('✖ Эта ячейка уже участвует в сделке'); break; }
        const offer: TradeOffer = {
          id: 'tr' + Math.random().toString(36).slice(2, 8),
          from: p.id, to: buyer.id, cellIdx: idx,
          priceMin: min, priceTries: tries, status: 'pending', ts: Date.now(),
        };
        s.trades = [...(s.trades ?? []).slice(-19), offer];
        const lbl = map.cells[idx]?.label ? ` «${map.cells[idx].label}»` : '';
        log(`💼 ${p.name} предлагает ${buyer.name}: ячейку №${idx + 1}${lbl} за ${priceStr(min, tries)}`);
        break;
      }
      const inv = p.inventory ?? (p.inventory = []);
      const card = inv.find((c) => c.id === (a as { cardId?: string }).cardId);
      if (!card) break;
      if (openTradeOfCard(card.id)) { log('✖ Эта карточка уже участвует в сделке'); break; }
      const offer: TradeOffer = {
        id: 'tr' + Math.random().toString(36).slice(2, 8),
        from: p.id, to: buyer.id, cardId: card.id,
        priceMin: min, priceTries: tries, status: 'pending', ts: Date.now(),
      };
      s.trades = [...(s.trades ?? []).slice(-19), offer];
      log(`💼 ${p.name} предлагает ${buyer.name}: «${card.name}» за ${priceStr(min, tries)}`);
      break;
    }
    case 'tradeReply': {
      if (s.phase !== 'playing') break;
      const o = (s.trades ?? []).find((x) => x.id === (a as { offerId?: string }).offerId);
      if (!o || o.status !== 'pending' || o.to !== aid) break;
      const kind = (a as { kind?: string }).kind;
      if (kind === 'decline') {
        o.status = 'declined';
        log(`${actor()?.name ?? 'Покупатель'} отказывается от сделки`);
        break;
      }
      if (kind === 'accept') { execTrade(o, o.priceMin, o.priceTries); break; }
      if (kind === 'counter') {
        const cm = Math.max(0, Math.min(90, Math.floor((a as { counterMin?: number }).counterMin ?? 0)));
        const ct = Math.max(0, Math.min(90, Math.floor((a as { counterTries?: number }).counterTries ?? 0)));
        if (cm + ct <= 0) break;
        o.counterMin = cm;
        o.counterTries = ct;
        o.status = 'countered';
        log(`${actor()?.name ?? 'Покупатель'} предлагает встречную цену: ${priceStr(cm, ct)}`);
      }
      break;
    }
    case 'tradeResolve': {
      if (s.phase !== 'playing') break;
      const o = (s.trades ?? []).find((x) => x.id === (a as { offerId?: string }).offerId);
      if (!o || o.from !== aid) break;
      if (!(a as { accept?: boolean }).accept) {
        if (o.status === 'pending' || o.status === 'countered') {
          o.status = 'declined';
          log(`${actor()?.name ?? 'Продавец'} отзывает предложение`);
        }
        break;
      }
      if (o.status === 'countered') execTrade(o, o.counterMin ?? 0, o.counterTries ?? 0);
      break;
    }
    case 'quizTarget': {
      // «кот в мешке»: спрашивающий передаёт вопрос любому игроку
      const q = s.quiz;
      if (!q || q.resolved || q.startedAt || s.phase !== 'playing') break;
      const qd = (map.quizzes ?? []).find((x) => x.id === q.quizId);
      if (!qd || qd.type !== 'mystery') break;
      if (a.id !== q.askerId) break;
      const asker = s.players.find((x) => x.id === q.askerId);
      const victim = s.players.find((x) => x.id === a.target && x.alive);
      if (!victim) break;
      q.targetId = victim.id;
      q.startedAt = Date.now();
      log(`🎁 ${asker?.name ?? 'Игрок'} передаёт «кота в мешке» → ${victim.name}`);
      break;
    }
    case 'quizAnswer': {
      const q = s.quiz;
      if (!q || q.resolved || s.phase !== 'playing' || !q.startedAt) break;
      const qd = (map.quizzes ?? []).find((x) => x.id === q.quizId);
      if (!qd) { s.quiz = null; endTurnNow(); break; }
      const answerer = s.players.find((x) => x.id === a.id);
      if (!answerer || !answerer.alive) break;
      // «кот в мешке» отвечает только получивший; в гонке — любой живой игрок
      if (qd.type === 'mystery' && q.targetId !== a.id) break;

      const answered = q.answered ?? (q.answered = []);
      const pending = q.pending ?? (q.pending = []);
      // в гонке каждый игрок фиксирует ответ ОДИН раз (верный или нет); «кот» может
      // пробовать снова после ошибки, но только до первого верного ответа
      const correctBy = q.correctBy ?? (q.correctBy = []);
      if (qd.type !== 'mystery' && (answered.some((x) => x.id === answerer.id) || pending.some((x) => x.id === answerer.id) || correctBy.includes(answerer.id))) break;
      if (qd.type === 'mystery' && pending.some((x) => x.id === answerer.id)) break;

      const norm = (x: string) => x.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
      let correct = false;
      if (a.answer === null || a.answer === undefined || String(a.answer).trim() === '') {
        correct = false;
      } else if (qd.type === 'text' || qd.type === 'music') {
        correct = (qd.answers ?? []).some((ans) => norm(ans) === norm(String(a.answer)));
      } else if (qd.type === 'order') {
        // ответ — «2|0|3|1»: порядок исходных (верных) индексов, как расставил игрок
        const want = (qd.items ?? []).map((_, i) => String(i)).join('|');
        correct = String(a.answer) === want;
      } else {
        correct = Number(a.answer) === qd.correct;
      }
      // время нажатия кнопки по часам САМОГО игрока — для честного «кто быстрее»
      const sentAt = typeof a.sentAt === 'number' ? a.sentAt : Date.now();

      // закрываем окно, когда все живые участники зафиксировали ответ
      const tryCloseWindow = () => {
        if (qd.type === 'mystery') return; // в «коте» участник один — закрывается сразу
        const doneIds = [...answered, ...pending, ...(q.correctBy ?? []).map((id) => ({ id }))].map((x) => x.id);
        if (alive().every((x) => doneIds.includes(x.id))) {
          if (qd.continueOnCorrect) {
            // марафон: бонус уже выдан каждому за верный ответ — просто закрываем
            if (q.resolved) return;
            const names = (q.correctBy ?? [])
              .map((id) => s.players.find((pl) => pl.id === id)?.name ?? '')
              .filter(Boolean);
            q.resolved = true;
            q.result = {
              correct: names.length > 0, deltaMin: 0, deltaTries: 0, targetName: '',
              reason: names.length > 0 ? 'correct' : 'allWrong', winners: names,
            };
            log(names.length > 0 ? `✔ Квиз завершён: верно ответили ${names.join(', ')}` : 'Квиз завершён: верных ответов не было');
          } else {
            settleQuiz(q, pending);
          }
        }
      };

      if (!correct) {
        // ОШИБКА: игрок выбывает из окна, квиз продолжается.
        // Ресурс снимается сразу — если только вопрос не помечен «без штрафа».
        // МОНЕТЫ активны: штраф монетами (вместо случайных минут/попыток).
        if (!qd.noPenalty) {
          if (map.startCoins !== undefined) {
            const lc = Math.max(0, Math.floor(map.quizLoseCoins ?? 0));
            answerer.coinsLeft = Math.max(0, (answerer.coinsLeft ?? 0) - lc);
            log(`✖ ${answerer.name}: неверно (−${lc} бронзы) — капитал ${coinsStr(answerer.coinsLeft)}`);
          } else {
            const kind = map.resMode === 'time' ? 'time' : map.resMode === 'tries' ? 'tries' : Math.random() < 0.5 ? 'time' : 'tries';
            if (kind === 'time') answerer.secLeft = Math.max(0, answerer.secLeft - 300);
            else answerer.triesLeft = Math.max(0, answerer.triesLeft - 5);
            log(`✖ ${answerer.name}: неверно (−5 ${kind === 'time' ? 'мин' : 'попыток'})`);
          }
        } else {
          log(`✖ ${answerer.name}: неверно (без штрафа)`);
        }
        if (!answered.some((x) => x.id === answerer.id)) answered.push({ id: answerer.id, name: answerer.name });
        tryCloseWindow();
        break;
      }

      // ВЕРНЫЙ ОТВЕТ в режиме «квиз продолжается»: бонус выдаётся СРАЗУ,
      // игрок больше не отвечает, а квиз идёт, пока не ответят все.
      if (qd.continueOnCorrect && qd.type !== 'mystery') {
        if (map.startCoins !== undefined) {
          const wc = Math.max(0, Math.floor(map.quizWinCoins ?? 0));
          answerer.coinsLeft = Math.min(COINS_MAX, (answerer.coinsLeft ?? 0) + wc);
          log(`✔ ${answerer.name}: верно! +${wc} бронзы — капитал ${coinsStr(answerer.coinsLeft)}`);
        } else {
          const kind = map.resMode === 'time' ? 'time' : map.resMode === 'tries' ? 'tries' : Math.random() < 0.5 ? 'time' : 'tries';
          if (kind === 'time') answerer.secLeft += 300;
          else answerer.triesLeft += 5;
          log(`✔ ${answerer.name}: верно! +5 ${kind === 'time' ? 'мин' : 'попыток'} — квиз продолжается`);
        }
        if (!correctBy.includes(answerer.id)) correctBy.push(answerer.id);
        tryCloseWindow();
        break;
      }

      // ВЕРНЫЙ ОТВЕТ (обычный и «кот в мешке»): первый же верный ответ
      // СРАЗУ завершает квиз — бонус получает ответивший. Остальные
      // ответить уже не успевают (галочка «верный ответ не завершает квиз»
      // выключена = обычный режим).
      if (!pending.some((x) => x.id === answerer.id)) pending.push({ id: answerer.id, name: answerer.name, sentAt });
      settleQuiz(q, pending);
      break;
    }
    case 'quizTimeout': {
      // время вышло: если есть собранные верные ответы — побеждает самый быстрый,
      // иначе штраф тому, на ком «висел» вопрос (в гонке — спросившему)
      const q = s.quiz;
      if (!q || q.resolved || !q.startedAt || s.phase !== 'playing') break;
      const qd = (map.quizzes ?? []).find((x) => x.id === q.quizId);
      if (!qd) { s.quiz = null; endTurnNow(); break; }
      if (Date.now() - q.startedAt < qd.timeLimit * 1000) break;
      // марафон: штрафы уже выданы за ошибки — таймаут просто закрывает квиз
      if (qd.continueOnCorrect && qd.type !== 'mystery') {
        const names = (q.correctBy ?? [])
          .map((id) => s.players.find((pl) => pl.id === id)?.name ?? '')
          .filter(Boolean);
        q.resolved = true;
        q.result = {
          correct: names.length > 0, deltaMin: 0, deltaTries: 0, targetName: '',
          reason: names.length > 0 ? 'correct' : 'timeout', winners: names,
        };
        log('⏱ Время квиза вышло');
        break;
      }
      const pending = q.pending ?? [];
      if (pending.length > 0) {
        settleQuiz(q, pending);
        break;
      }
      const loserId = qd.type === 'mystery' ? q.targetId : q.askerId;
      const loser = s.players.find((x) => x.id === loserId);
      if (!loser) { s.quiz = null; endTurnNow(); break; }
      let deltaMin = 0;
      let deltaTries = 0;
      if (map.startCoins !== undefined) {
        // МОНЕТЫ активны: штраф за таймаут монетами
        const lc = Math.max(0, Math.floor(map.quizLoseCoins ?? 0));
        loser.coinsLeft = Math.max(0, (loser.coinsLeft ?? 0) - lc);
        q.result = { correct: false, deltaMin: 0, deltaTries: 0, targetName: loser.name, reason: 'timeout' };
        log(`⏰ Время вышло! ${loser.name}: −${lc} бронзы — капитал ${coinsStr(loser.coinsLeft)}`);
      } else {
        const kind = map.resMode === 'time' ? 'time' : map.resMode === 'tries' ? 'tries' : Math.random() < 0.5 ? 'time' : 'tries';
        if (kind === 'time') { loser.secLeft = Math.max(0, loser.secLeft - 300); deltaMin = -5; }
        else { loser.triesLeft = Math.max(0, loser.triesLeft - 5); deltaTries = -5; }
        q.result = { correct: false, deltaMin, deltaTries, targetName: loser.name, reason: 'timeout' };
        log(`⏰ Время вышло! ${loser.name}: ${kind === 'time' ? '−5 мин' : '−5 попыток'}`);
      }
      q.resolved = true;
      checkElim();
      break;
    }
    case 'quizDone': {
      const q = s.quiz;
      if (!q || !q.resolved || s.phase !== 'playing') break;
      if (a.id !== q.askerId) break; // ход передаёт тот, кто встал на ячейку
      s.quiz = null;
      const p = current();
      p.extraTurn = false;
      log(`${p.name} передаёт ход после квиза`);
      endTurnNow();
      break;
    }
    case 'cardAck': {
      if (!s.pendingCard) break;
      s.pendingCard = null;
      s.moving = null;
      checkElim();
      if (s.phase === 'playing' && !s.challenge) endTurnNow();
      break;
    }
  }
  return s;
}
