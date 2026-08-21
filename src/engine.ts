import type { CardDef, GameMap, GameOptions, GameSession, PlayerState, TaskDef } from './types';
import { APP_VERSION, SKIP_COST, START_SEC, START_TRIES } from './types';

export type Action =
  | { t: 'hello'; id: string; name: string }
  | { t: 'ready'; id: string; ready: boolean }
  | { t: 'kick'; id: string }
  | { t: 'start' }
  | { t: 'roll'; id: string; holdMs: number }
  | { t: 'arrived'; id: string }
  | { t: 'chooseMode'; id: string; mode: 'time' | 'tries' }
  | { t: 'startTask'; id: string }
  | { t: 'togglePause'; id: string }
  | { t: 'token'; id: string; tokenImg: string | null }
  | { t: 'reloadSave'; id: string }
  | { t: 'declareDone'; id: string }
  | { t: 'approve'; id: string }
  | { t: 'violate'; id: string }
  | { t: 'skip'; id: string; instant: boolean; spentMs: number; loads: number; resource?: 'time' | 'tries' }
  | { t: 'postChoice'; id: string; choice: 'continue' | 'end' }
  | { t: 'setCellTask'; id: string; cellIdx: number; task: TaskDef }
  | { t: 'quizAnswer'; id: string; answer: number | string | null }
  | { t: 'quizTarget'; id: string; target: string }
  | { t: 'quizTimeout' }
  | { t: 'quizDone'; id: string }
  | { t: 'cardAck'; id: string };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const rnd6 = () => 1 + Math.floor(Math.random() * 6);

function mkPlayer(id: string, name: string, color: number, isHost: boolean): PlayerState {
  return {
    id, name: name.slice(0, 14).toUpperCase() || 'ИГРОК', color, ready: isHost, isHost,
    secLeft: START_SEC, triesLeft: START_TRIES, pos: 0, alive: true, skipTurns: 0, extraTurn: false,
  };
}

export function newSession(code: string, mapId: string, hostId: string, hostName: string): GameSession {
  return {
    v: APP_VERSION, code, mapId, usedQuizzes: [], phase: 'lobby',
    players: [mkPlayer(hostId, hostName, 0, true)],
    rollOffIdx: 0, rollOffValues: {}, turn: 0,
    dice: null, moving: null, challenge: null, pendingCard: null, quiz: null, notice: null,
    captured: {}, sessionTasks: {}, awaitPost: false, revealed: [],
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
  const s = clone(s0);
  // старые сохранённые сессии могут не иметь новых полей
  if (!s.usedQuizzes) s.usedQuizzes = [];
  if (s.quiz === undefined) s.quiz = null;
  const log: Log = (t) => { s.log = [t, ...s.log].slice(0, 50); };
  const alive = () => s.players.filter((p) => p.alive);
  const aid = 'id' in a ? (a as { id: string }).id : '';
  const actor = () => s.players.find((p) => p.id === aid);
  const current = () => s.players[s.turn % s.players.length];

  const nextTurn = () => {
    const al = alive();
    if (al.length <= 1) {
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
      if (!np.alive) continue;
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
    for (const p of s.players) {
      if (p.alive && p.secLeft <= 0 && p.triesLeft <= 0) {
        p.alive = false;
        if (s.challenge && current().id === p.id) s.challenge = null;
        if (s.pendingCard && s.pendingCard.player === p.id) s.pendingCard = null;
        s.awaitPost = false;
        s.moving = null;
        log(`💀 ${p.name} выбывает — ресурсы исчерпаны`);
      }
    }
    const al = alive();
    if (s.phase === 'playing' && al.length <= 1) {
      s.phase = 'over';
      s.winner = al[0]?.id ?? null;
      if (s.winner) log(`🏆 ${al[0].name} — ПОБЕДИТЕЛЬ!`);
      return;
    }
    if (!current().alive && s.phase === 'playing') nextTurn();
  };

  const endTurnNow = () => {
    if (s.phase !== 'playing') return;
    nextTurn();
  };

  const finishChallenge = (success: boolean, spentSec: number, spentTries: number) => {
    const ch = s.challenge;
    if (!ch) return;
    const p = current();
    const cellNo = ch.cellIdx + 1;
    p.secLeft = Math.max(0, p.secLeft - spentSec);
    p.triesLeft = Math.max(0, p.triesLeft - spentTries);
    const ownerId = s.captured[ch.cellIdx];
    const owner = ownerId && ownerId !== p.id ? s.players.find((x) => x.id === ownerId && x.alive) : undefined;
    if (owner && (spentSec > 0 || spentTries > 0)) {
      owner.secLeft += spentSec;
      owner.triesLeft += spentTries;
      log(`⚡ Ресурсы (${spentSec ? `${Math.round(spentSec / 60)} мин` : ''}${spentTries ? ` ${spentTries} поп.` : ''}) ушли хозяину ${owner.name}`);
    }
    if (success) {
      s.captured[ch.cellIdx] = p.id;
      log(`✅ ${p.name} захватывает ячейку №${cellNo}`);
      s.awaitPost = true;
    } else {
      log(`⏭ ${p.name} пропускает задание на ячейке №${cellNo}`);
    }
    s.challenge = null;
    if (!success) endTurnNow();
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
    if (cell.type === 'bonus' || cell.type === 'trap') {
      const deck = cell.type === 'bonus' ? map.bonusCards : map.trapCards;
      if (deck.length === 0) {
        log(`Ячейка №${cell.n} пуста — передышка`);
        s.notice = { text: `Ячейка №${cell.n} (${cell.type === 'bonus' ? 'бонус' : 'ловушка'}) без карточек — передышка. Добавьте карточки в редакторе заданий.`, ts: Date.now() };
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
        log(`Ячейка №${cell.n} — квиз, но на карте нет вопросов. Передышка`);
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
        log(`🎁 ${p.name} встал на «кота в мешке» (ячейка №${cell.n}) — выбирает, кому передать вопрос`);
      } else {
        // гонка: вопрос видят все, отвечает кто быстрее
        s.quiz = { quizId: q.id, askerId: p.id, targetId: p.id, startedAt: Date.now(), resolved: false };
        log(`🎲 КВИЗ (ячейка №${cell.n})! Вопрос видят все — кто первым ответит, тот и забирает`);
      }
      return;
    }
    const task = cellTaskOf(s, map, p.pos);
    if (!task) {
      log(`Ячейка №${cell.n} без задания — передышка`);
      s.notice = { text: `Ячейка №${cell.n} без задания — передышка. Назначьте ей ром и сохранение в редакторе заданий.`, ts: Date.now() };
      endTurnNow();
      return;
    }
    if (s.captured[p.pos] === p.id) {
      log(`${p.name} на своей ячейке №${cell.n} — отдых`);
      endTurnNow();
      return;
    }
    s.notice = null;
    s.challenge = {
      cellIdx: p.pos, mode: null, started: false, paused: false, startedAt: 0, accMs: 0, loads: 0, reloadId: 0,
      status: 'choose', approvals: [], violations: [], lowStart: false,
    };
    const owner = s.captured[p.pos] ? s.players.find((x) => x.id === s.captured[p.pos]) : null;
    log(`🎯 ${p.name}: задание на ячейке №${cell.n}${owner ? ` (хозяин ${owner.name})` : ''}`);
  };

  const applyCard = (p: PlayerState, card: CardDef) => {
    const e = card.effect;
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
        const to = norm(p.pos + e.value);
        s.moving = { player: p.id, path: stepsTo(p.pos, to, e.value >= 0 ? 1 : -1), ts: Date.now() };
        p.pos = to;
        log(`${p.name} → ячейка №${to + 1}`);
        break;
      }
      case 'teleport': {
        const to = Math.min(Math.max(1, e.value), N) - 1;
        s.moving = { player: p.id, path: [to], ts: Date.now() };
        p.pos = to;
        log(`${p.name} → ячейка №${to + 1}`);
        break;
      }
      case 'jail':
        p.skipTurns += Math.max(1, e.value);
        log(`${p.name}: отпуск — пропуск ${Math.max(1, e.value)} х.`);
        break;
      case 'wrongway': {
        let to = -1;
        for (let st = 1; st <= N; st++) {
          const c = map.cells[norm(p.pos + st)];
          if (c.type === 'trap' || c.type === 'bonus') { to = norm(p.pos + st); break; }
        }
        if (to < 0) to = norm(p.pos - 3);
        s.moving = { player: p.id, path: stepsTo(p.pos, to, 1), ts: Date.now() };
        p.pos = to;
        log(`${p.name}: поворот не туда → №${to + 1}`);
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
    }
  };

  switch (a.t) {
    case 'hello': {
      if (s.phase !== 'lobby' || s.players.length >= 4 || s.players.some((p) => p.id === a.id)) return s0;
      s.players.push(mkPlayer(a.id, a.name, s.players.length, false));
      log(`${a.name.toUpperCase()} подключается`);
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
      s.phase = 'rollOff';
      s.rollOffIdx = 0;
      s.rollOffValues = {};
      log('Игра начинается! Бросок за первый ход…');
      break;
    }
    case 'roll': {
      if (s.phase === 'rollOff') {
        if (s.rollOffIdx >= s.players.length) break;
        const p = s.players[s.rollOffIdx];
        if (p.id !== a.id) break;
        const v = rnd6();
        s.rollOffValues[p.id] = v;
        s.rollOffIdx++;
        log(`🎲 ${p.name} выбрасывает ${v}`);
        if (s.rollOffIdx >= s.players.length) {
          const vals = s.players.map((p) => s.rollOffValues[p.id] ?? 0);
          const max = Math.max(...vals);
          const leaders = s.players.filter((p) => (s.rollOffValues[p.id] ?? 0) === max);
          if (leaders.length === 1) {
            s.turn = s.players.indexOf(leaders[0]);
            s.phase = 'playing';
            log(`🚀 Первым ходит ${leaders[0].name}!`);
          } else {
            s.rollOffValues = {};
            s.rollOffIdx = 0;
            log('Ничья! Бросаем ещё раз…');
          }
        }
        break;
      }
      if (s.phase !== 'playing') break;
      const p = current();
      if (!p || p.id !== a.id || s.moving || s.challenge || s.pendingCard || s.awaitPost || s.quiz) break;
      s.notice = null;
      const shuffles = Math.min(6, 1 + Math.floor(Math.max(0, a.holdMs) / 450));
      let va = rnd6();
      for (let i = 1; i < shuffles; i++) va = rnd6();
      const vb = rnd6();
      s.dice = { a: va, b: vb, roll: (s.dice?.roll ?? 0) + 1 };
      const N = map.cells.length;
      const path: number[] = [];
      for (let i = 1; i <= va + vb; i++) path.push((p.pos + i) % N);
      s.moving = { player: p.id, path, ts: Date.now() };
      log(`🎲 ${p.name}: ${va} + ${vb} = ${va + vb}`);
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
    case 'chooseMode': {
      const ch = s.challenge;
      const p = current();
      if (!ch || ch.status !== 'choose' || p.id !== a.id) break;
      // с нулём ресурса выбирать его нельзя
      if (a.mode === 'time' && p.secLeft <= 0) break;
      if (a.mode === 'tries' && p.triesLeft <= 0) break;
      ch.mode = a.mode;
      // если ресурса меньше 5 — пропуск станет доступен только на нуле
      const remaining = a.mode === 'time' ? Math.floor(p.secLeft / 60) : p.triesLeft;
      ch.lowStart = remaining < SKIP_COST;
      ch.status = 'ready'; // выбран ресурс, но запуск — по команде игрока
      log(`${p.name}: ${a.mode === 'time' ? 'играет на ВРЕМЯ ⏱' : 'играет на ПОПЫТКИ 🎯'}`);
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
      } else {
        ch.startedAt = Date.now();
        ch.accMs = 0;
      }
      log(`▶ ${p.name} запускает задание${ch.mode === 'tries' ? ' — попытка №1' : ' — таймер пошёл'}`);
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
      if (p && (s.phase === 'lobby' || s.phase === 'rollOff')) p.tokenImg = a.tokenImg;
      break;
    }
    case 'reloadSave': {
      const ch = s.challenge;
      const p = current();
      if (!ch || ch.status !== 'playing' || p.id !== a.id) break;
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

      // правило: если на старте ресурса было меньше 5 — пропуск разрешён только при нуле
      const nowMs = Date.now();
      const running = ch.mode === 'time' && ch.started && !ch.paused && ch.startedAt > 0;
      const ms = ch.accMs + (running ? nowMs - ch.startedAt : 0);
      if (ch.mode && ch.lowStart) {
        const rem = ch.mode === 'time' ? p.secLeft : p.triesLeft;
        if (rem > 0) break;
      }
      // обычный пропуск требует 5 потраченных ресурсов
      if (ch.mode && !a.instant) {
        const units = ch.mode === 'time' ? Math.floor(ms / 60000) : ch.loads;
        if (!ch.lowStart && units < SKIP_COST) break;
      }

      if (ch.mode === 'time' && !a.instant) {
        const cost = Math.max(1, Math.ceil(ms / 60000));
        finishChallenge(false, Math.min(cost, Math.max(1, Math.floor(p.secLeft / 60))) * 60, 0);
      } else if (ch.mode === 'tries' && !a.instant) {
        const cost = Math.max(ch.loads, SKIP_COST);
        finishChallenge(false, 0, Math.min(cost, Math.max(1, p.triesLeft)));
      } else if (a.instant && a.resource === 'time') {
        // мгновенный пропуск за 5 минут (или сколько осталось)
        finishChallenge(false, Math.min(SKIP_COST, Math.floor(p.secLeft / 60)) * 60, 0);
      } else if (a.instant && a.resource === 'tries') {
        // мгновенный пропуск за 5 попыток (или сколько осталось)
        finishChallenge(false, 0, Math.min(SKIP_COST, Math.max(1, p.triesLeft)));
      } else {
        // мгновенный пропуск в выбранном режиме
        if (ch.mode === 'time') finishChallenge(false, Math.min(SKIP_COST, Math.floor(p.secLeft / 60)) * 60, 0);
        else finishChallenge(false, 0, Math.min(SKIP_COST, Math.max(1, p.triesLeft)));
      }
      checkElim();
      break;
    }
    case 'postChoice': {
      const p = current();
      if (!s.awaitPost || p.id !== a.id) break;
      s.awaitPost = false;
      if (a.choice === 'end') endTurnNow();
      else log(`${p.name} продолжает ход`);
      break;
    }
    case 'setCellTask': {
      const p = current();
      if (!s.awaitPost || p.id !== a.id) break;
      s.sessionTasks[a.cellIdx] = a.task;
      s.awaitPost = false;
      log(`🛠 ${p.name} создаёт новое задание на ячейке №${a.cellIdx + 1} (доп. ход сгорает)`);
      endTurnNow();
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
      // «кот в мешке» отвечает только получивший; в гонке — любой, кто успел первым
      if (qd.type === 'mystery' && q.targetId !== a.id) break;
      const norm = (x: string) => x.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
      let correct = false;
      if (a.answer === null || a.answer === undefined || String(a.answer).trim() === '') {
        correct = false;
      } else if (qd.type === 'text' || qd.type === 'music') {
        correct = (qd.answers ?? []).some((ans) => norm(ans) === norm(String(a.answer)));
      } else {
        correct = Number(a.answer) === qd.correct;
      }
      // награда/штраф достаётся тому, кто ответил
      const kind = Math.random() < 0.5 ? 'time' : 'tries';
      let deltaMin = 0;
      let deltaTries = 0;
      if (correct) {
        if (kind === 'time') { answerer.secLeft += 300; deltaMin = 5; }
        else { answerer.triesLeft += 5; deltaTries = 5; }
      } else {
        if (kind === 'time') { answerer.secLeft = Math.max(0, answerer.secLeft - 300); deltaMin = -5; }
        else { answerer.triesLeft = Math.max(0, answerer.triesLeft - 5); deltaTries = -5; }
      }
      q.resolved = true;
      q.result = { correct, deltaMin, deltaTries, targetName: answerer.name };
      const deltaTxt = kind === 'time' ? `${correct ? '+' : '−'}5 мин` : `${correct ? '+' : '−'}5 попыток`;
      log(correct ? `✔ ${answerer.name}: верный ответ на квиз! ${deltaTxt}` : `✖ ${answerer.name}: неверно. ${deltaTxt}`);
      checkElim();
      break;
    }
    case 'quizTimeout': {
      // время вышло: штраф тому, на ком «висел» вопрос (в гонке — спросившему)
      const q = s.quiz;
      if (!q || q.resolved || !q.startedAt || s.phase !== 'playing') break;
      const qd = (map.quizzes ?? []).find((x) => x.id === q.quizId);
      if (!qd) { s.quiz = null; endTurnNow(); break; }
      if (Date.now() - q.startedAt < qd.timeLimit * 1000) break;
      const loserId = qd.type === 'mystery' ? q.targetId : q.askerId;
      const loser = s.players.find((x) => x.id === loserId);
      if (!loser) { s.quiz = null; endTurnNow(); break; }
      const kind = Math.random() < 0.5 ? 'time' : 'tries';
      let deltaMin = 0;
      let deltaTries = 0;
      if (kind === 'time') { loser.secLeft = Math.max(0, loser.secLeft - 300); deltaMin = -5; }
      else { loser.triesLeft = Math.max(0, loser.triesLeft - 5); deltaTries = -5; }
      q.resolved = true;
      q.result = { correct: false, deltaMin, deltaTries, targetName: loser.name };
      log(`⏰ Время вышло! ${loser.name}: ${kind === 'time' ? '−5 мин' : '−5 попыток'}`);
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
