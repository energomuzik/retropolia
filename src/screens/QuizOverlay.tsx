import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { dispatch } from '../useGame';
import { GhostBtn, Ic, PxBtn } from '../ui';
import { PLAYER_COLORS } from '../types';
import { sfx } from '../sound';

/**
 * Квиз поверх игрового экрана.
 * — «Гонка» (choice/text/music): вопрос видят ВСЕ живые игроки, отвечает кто первым.
 *   Верный ответ — бонус ответившему (+5 мин или попыток, случайно), ошибка — штраф ему же.
 * — «Кот в мешке» (mystery): спросивший передаёт вопрос любому игроку, отвечает только он.
 * — Время вышло — штраф тому, на ком «висел» вопрос. После ответа ход всё равно передаётся.
 */
export default function QuizOverlay() {
  const session = useApp((st) => st.session);
  const map = useApp((st) => st.sessionMap);
  const me = useApp((st) => st.selfId);

  const q = session?.quiz ?? null;
  const quiz = q && map ? (map.quizzes ?? []).find((x) => x.id === q.quizId) : undefined;
  const mePlayer = session?.players.find((p) => p.id === me);
  const asker = session?.players.find((p) => p.id === q?.askerId);
  const victim = session?.players.find((p) => p.id === q?.targetId);

  const [, setTick] = useState(0);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const wasResolvedRef = useRef(false);
  /* Таймер идёт по ЛОКАЛЬНЫМ часам игрока с момента, когда он получил вопрос.
     Иначе рассинхрон часов двух ПК (±5–10 с) давал одному игроку меньше времени. */
  const localStartRef = useRef(0);

  // сброс локального состояния при новом вопросе
  useEffect(() => {
    setText('');
    setSent(false);
    wasResolvedRef.current = false;
  }, [q?.quizId, q?.startedAt]);

  // запоминаем локальный момент старта отсчёта для этого вопроса
  useEffect(() => {
    if (q?.startedAt && q.startedAt > 0) localStartRef.current = Date.now();
    else localStartRef.current = 0;
  }, [q?.quizId, q?.startedAt]);

  // тик таймера
  useEffect(() => {
    if (!q || q.resolved) return;
    const t = setInterval(() => setTick((x) => x + 1), 200);
    return () => clearInterval(t);
  }, [q?.resolved, q?.quizId, q?.startedAt]);

  // время вышло — сообщаем движку (редьюсер идемпотентен)
  useEffect(() => {
    if (!q || !quiz || q.resolved || !q.startedAt) return;
    const t = setInterval(() => {
      if (Date.now() - q.startedAt >= quiz.timeLimit * 1000) dispatch({ t: 'quizTimeout' });
    }, 300);
    return () => clearInterval(t);
  }, [q?.quizId, q?.startedAt, q?.resolved, quiz?.timeLimit]);

  // звук при разрешении
  useEffect(() => {
    if (q?.resolved && !wasResolvedRef.current) {
      wasResolvedRef.current = true;
      if (q.result?.correct) sfx.success();
      else sfx.fail();
    }
  }, [q?.resolved, q?.result]);

  if (!session || !q || !quiz || !mePlayer || !mePlayer.alive) return null;

  const isMystery = quiz.type === 'mystery';
  const picking = isMystery && !q.startedAt;
  const limit = Math.max(5, quiz.timeLimit);
  const remain = q.startedAt && localStartRef.current
    ? Math.max(0, limit - (Date.now() - localStartRef.current) / 1000)
    : limit;
  const remainPct = Math.max(0, Math.min(100, (remain / limit) * 100));
  const iAmAsker = me === q.askerId;
  const iAmTarget = me === q.targetId;
  const wrongList = q.answered ?? [];
  const pendingList = q.pending ?? [];
  const correctList = q.correctBy ?? [];
  const meWrong = wrongList.some((x) => x.id === me);
  const mePending = pendingList.some((x) => x.id === me);
  const meCorrect = correctList.includes(me);
  // гонка: каждый отвечает один раз (после ошибки или верного — выбыл); «кот»: получивший может пробовать снова
  const canAnswer = !q.resolved && q.startedAt > 0 && (isMystery ? iAmTarget && (!sent || meWrong) : !sent && !meWrong && !meCorrect);
  const seesQuestion = !isMystery || iAmTarget || q.resolved;

  const submit = (answer: number | string) => {
    if (!canAnswer) return;
    if (typeof answer === 'string' && !answer.trim()) return;
    setSent(true);
    sfx.click();
    // sentAt — время нажатия по часам игрока: хост определит «кто быстрее» честно,
    // не по порядку прихода сообщений (иначе у хоста было бы преимущество по пингу)
    dispatch({ t: 'quizAnswer', id: me, answer, sentAt: Date.now() });
  };

  const accent = isMystery ? '#ff8b3f' : '#5aa9ff';
  const correctText =
    quiz.type === 'choice'
      ? quiz.options?.[quiz.correct ?? 0] ?? ''
      : (quiz.answers ?? []).filter((x) => x.trim()).join(' / ');

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[rgba(4,6,14,0.82)]" />
      <div className="relative pixel-panel pixel-corners pop-in w-full max-w-2xl max-h-[92vh] overflow-y-auto" style={{ borderColor: accent }}>
        {/* шапка */}
        <div className="flex items-center gap-3 px-5 py-3 border-b-[3px] border-edge" style={{ background: 'rgba(0,0,0,0.25)' }}>
          <span style={{ color: accent }}>{isMystery ? Ic.cart(20) : Ic.bolt(20)}</span>
          <div className="flex-1">
            <div className="font-display uppercase tracking-wider text-sm" style={{ color: accent }}>
              {isMystery ? 'Кот в мешке' : 'Квиз-гонка'}
            </div>
            <div className="tick-label text-faint mt-0.5">
              {iAmAsker ? `Вы встали на ячейку квиза` : `Спросил: ${asker?.name ?? '—'}`}
              {isMystery && !picking && victim ? ` · отвечает ${victim.name}` : ''}
            </div>
          </div>
          {q.startedAt > 0 && !q.resolved && (
            <div className="text-right">
              <div className={`font-pixel text-lg ${remain <= 5 ? 'text-coral blink-hard' : 'text-paper'}`}>{Math.ceil(remain)}</div>
              <div className="tick-label text-faint">сек</div>
            </div>
          )}
        </div>

        {/* полоса времени */}
        {q.startedAt > 0 && !q.resolved && (
          <div className="h-2 bg-[rgba(0,0,0,0.4)]">
            <div
              className="h-full transition-[width] duration-200"
              style={{ width: `${remainPct}%`, background: remain <= 5 ? '#ff5d73' : accent }}
            />
          </div>
        )}

        <div className="p-5">
          {/* ---------- выбор жертвы «кота в мешке» ---------- */}
          {picking && iAmAsker && (
            <div>
              <p className="text-[13px] text-dim mb-4">
                Вам попался «кот в мешке»! Выберите игрока, которому передадите вопрос — отвечать будет он.
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                {session.players.filter((p) => p.alive).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { sfx.card(); dispatch({ t: 'quizTarget', id: me, target: p.id }); }}
                    className="pixel-panel pixel-corners p-3 flex items-center gap-3 hover:-translate-y-0.5 hover:border-edge2 transition-all cursor-pointer text-left"
                  >
                    <span className="w-8 h-8 border-2 border-abyss shrink-0" style={{ background: PLAYER_COLORS[p.color] }} />
                    <span className="font-display uppercase text-[12px] text-paper truncate">
                      {p.name} {p.id === me && <span className="text-faint text-[10px]">(вы)</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {picking && !iAmAsker && (
            <div className="text-center py-8">
              <span className="text-magma inline-block floaty">{Ic.cart(40)}</span>
              <p className="font-pixel text-[9px] text-dim mt-4 blink-hard">
                {asker?.name ?? 'Игрок'} выбирает, кому достанется кот в мешке…
              </p>
            </div>
          )}

          {/* ---------- вопрос ---------- */}
          {!picking && q.startedAt > 0 && (
            <>
              {seesQuestion ? (
                <div className="space-y-4">
                  {quiz.imageId && (
                    <img src={quiz.imageId} alt="" className="mx-auto max-h-44 border-[3px] border-edge object-contain pop-in" />
                  )}
                  {quiz.audioId && (
                    <div className="flex items-center gap-3 hud-chip pixel-corners px-3 py-2.5">
                      <span className="text-sky shrink-0">{Ic.play(16)}</span>
                      <audio key={q.startedAt} src={quiz.audioId} controls autoPlay loop className="h-9 flex-1 min-w-0" />
                    </div>
                  )}
                  <p className="font-display text-lg leading-snug text-paper text-center px-2">{quiz.question}</p>

                  {!q.resolved && (
                    <>
                      {!isMystery && (
                        <p className="text-center text-[11px] text-sky">
                          Гонка: вопрос видят все. Первый верный ответ забирает бонус, ошибка — штраф ответившему.
                          Квиз идёт, пока кто-то не ответит верно, не ошибутся все или не выйдет время!
                        </p>
                      )}
                      {meWrong && !q.resolved && (
                        <div className="hud-chip pixel-corners border-coral px-3 py-2 text-center">
                          <span className="font-display text-[11px] uppercase text-coral">
                            Ваш ответ неверный{quiz.noPenalty ? ' (без штрафа).' : ' — −5 ресурсов.'}{' '}
                            {isMystery ? 'Таймер идёт — пробуйте снова!' : 'Ждём остальных игроков…'}
                          </span>
                        </div>
                      )}
                      {meCorrect && !q.resolved && (
                        <div className="hud-chip pixel-corners border-teal px-3 py-2 text-center">
                          <span className="font-display text-[11px] uppercase text-teal">
                            Верно! +5 ресурсов — ждём остальных игроков…
                          </span>
                        </div>
                      )}
                      {!isMystery && wrongList.length > 0 && (
                        <div className="flex items-center justify-center gap-2 flex-wrap">
                          <span className="tick-label text-faint">Ошиблись:</span>
                          {wrongList.map((w) => (
                            <span key={w.id} className="hud-chip pixel-corners px-2 py-0.5 font-pixel text-[8px] text-coral">
                              ✖ {w.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {!isMystery && correctList.length > 0 && (
                        <div className="flex items-center justify-center gap-2 flex-wrap">
                          <span className="tick-label text-faint">Верно:</span>
                          {correctList.map((id) => {
                            const pl = session?.players.find((p) => p.id === id);
                            return (
                              <span key={id} className="hud-chip pixel-corners px-2 py-0.5 font-pixel text-[8px] text-teal">
                                ✔ {pl?.name ?? '—'}
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {!isMystery && pendingList.length > 0 && (
                        <div className="flex items-center justify-center gap-2 flex-wrap">
                          <span className="tick-label text-faint">Ответили верно (ждём окно):</span>
                          {pendingList.map((w) => (
                            <span key={w.id} className="hud-chip pixel-corners px-2 py-0.5 font-pixel text-[8px] text-teal">
                              ✔ {w.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {!isMystery && pendingList.length > 0 && !q.resolved && (
                        <p className="text-center text-[10.5px] text-sky leading-snug">
                          Идёт окно сбора: бонус получит самый быстрый верный ответ, когда окно закроется
                          (ответят все или выйдет время).
                        </p>
                      )}
                      {quiz.type === 'choice' ? (
                        <div className="grid sm:grid-cols-2 gap-2.5">
                          {(quiz.options ?? []).map((opt, i) => (
                            <button
                              key={i}
                              disabled={!canAnswer}
                              onClick={() => submit(i)}
                              className="pixel-panel pixel-corners p-3.5 text-left flex items-start gap-3 transition-all cursor-pointer hover:border-gold hover:-translate-y-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <span className="font-pixel text-[10px] text-gold mt-0.5 shrink-0">{String.fromCharCode(65 + i)}</span>
                              <span className="text-[13px] text-paper leading-snug">{opt}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <input
                            autoFocus
                            className="field-in flex-1 px-3 py-2.5 text-sm"
                            placeholder="Ваш ответ…"
                            value={text}
                            disabled={!canAnswer}
                            onChange={(e) => setText(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') submit(text); }}
                          />
                          <PxBtn color="sky" disabled={!canAnswer || !text.trim()} onClick={() => submit(text)}>
                            {Ic.check(14)} Ответить
                          </PxBtn>
                        </div>
                      )}
                      {sent && !meWrong && (
                        <p className={`text-center font-pixel text-[8px] blink-hard ${mePending ? 'text-teal' : 'text-gold'}`}>
                          {mePending ? '✔ ОТВЕТ ПРИНЯТ — ЖДЁМ ОКНО СБОРА' : 'ОТВЕТ ОТПРАВЛЕН…'}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="text-center py-8">
                  <span className="text-magma inline-block floaty">{Ic.cart(40)}</span>
                  <p className="font-pixel text-[9px] text-dim mt-4">
                    ВОПРОС ПЕРЕДАН {victim?.name ?? 'ИГРОКУ'} — ЖДЁМ ОТВЕТА
                  </p>
                  <p className="text-[11px] text-faint mt-2">Содержимое «мешка» скрыто до результата</p>
                </div>
              )}
            </>
          )}

          {/* ---------- результат ---------- */}
          {q.resolved && q.result && (
            <div className="text-center pt-2 pop-in">
              <div
                className={`font-pixel text-xl title-glow ${
                  q.result.correct ? 'text-teal' : q.result.reason === 'timeout' ? 'text-gold' : 'text-coral'
                }`}
              >
                {q.result.correct ? 'ВЕРНО!' : q.result.reason === 'timeout' ? 'ВРЕМЯ ВЫШЛО' : 'ОШИБЛИСЬ ВСЕ'}
              </div>

              {q.result.correct ? (
                <p className="text-[13px] text-paper mt-3">
                  {q.result.targetName} — самый быстрый верный ответ:{' '}
                  <span className="text-teal">
                    {q.result.deltaMin !== 0 ? `+${q.result.deltaMin} минут` : `+${q.result.deltaTries} попыток`}
                  </span>
                </p>
              ) : q.result.reason === 'timeout' ? (
                <p className="text-[13px] text-paper mt-3">
                  Вопрос повис на игроке {q.result.targetName}:{' '}
                  <span className="text-coral">
                    {q.result.deltaMin !== 0 ? `−${Math.abs(q.result.deltaMin)} минут` : `−${Math.abs(q.result.deltaTries)} попыток`}
                  </span>
                </p>
              ) : (
                <p className="text-[13px] text-dim mt-3">Каждый ответивший потерял по 5 ресурсов — бонус никто не забрал</p>
              )}

              {wrongList.length > 0 && (
                <div className="flex items-center justify-center gap-2 flex-wrap mt-3">
                  <span className="tick-label text-faint">Штрафы за ошибки:</span>
                  {wrongList.map((w) => (
                    <span key={w.id} className="hud-chip pixel-corners px-2 py-0.5 font-pixel text-[8px] text-coral">
                      ✖ {w.name}{quiz.noPenalty ? '' : ' −5'}
                    </span>
                  ))}
                </div>
              )}
              {(q.result.winners ?? []).length > 0 && (
                <div className="flex items-center justify-center gap-2 flex-wrap mt-3">
                  <span className="tick-label text-faint">Ответили верно (+5):</span>
                  {q.result.winners!.map((nm, i) => (
                    <span key={i} className="hud-chip pixel-corners px-2 py-0.5 font-pixel text-[8px] text-teal">
                      ✔ {nm}
                    </span>
                  ))}
                </div>
              )}

              {correctText && (
                <p className="text-[12px] text-dim mt-2">
                  Правильный ответ: <span className="text-teal">{correctText}</span>
                </p>
              )}
              <p className="text-[11px] text-faint mt-3">
                {iAmAsker ? 'Нажмите «Дальше», чтобы передать ход' : 'Ход передаст тот, кто встал на ячейку квиза'}
              </p>
              {iAmAsker && (
                <div className="mt-4">
                  <PxBtn big onClick={() => { sfx.click(); dispatch({ t: 'quizDone', id: me }); }}>
                    {Ic.dice(16)} Дальше
                  </PxBtn>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
