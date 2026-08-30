import { useRef, useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Panel, PxBtn, Stepper, Toggle } from '../ui';
import { fileToDataUrl } from '../assets';
import { idbPut, uid } from '../db';
import type { GameMap, QuizDef, QuizType } from '../types';
import { sfx } from '../sound';

const TYPE_META: { key: QuizType; label: string; hint: string; color: string }[] = [
  { key: 'choice', label: 'Выбор из 4', hint: 'картинка + вопрос + 4 варианта', color: 'var(--color-gold)' },
  { key: 'text', label: 'Свой ответ', hint: 'вопрос + несколько верных написаний', color: 'var(--color-teal)' },
  { key: 'music', label: 'Музыкальный', hint: 'мелодия + вопрос + 4 варианта', color: 'var(--color-coral)' },
  { key: 'mystery', label: 'Кот в мешке', hint: 'вопрос передаётся случайному игроку', color: 'var(--color-sky)' },
];

export default function QuizEditor() {
  const { maps, setScreen, refresh, toast } = useApp();
  const [map, setMap] = useState<GameMap | null>(null);
  const [draft, setDraft] = useState<QuizDef | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  const quizzes = map?.quizzes ?? [];
  const quizCellCount = map?.cells.filter((c) => c.type === 'quiz').length ?? 0;

  const openMap = (m: GameMap) => {
    setMap(JSON.parse(JSON.stringify(m)) as GameMap);
    setDraft(null);
    setEditingId(null);
    sfx.coin();
  };

  const persist = async (m: GameMap) => {
    m.updatedAt = Date.now();
    await idbPut('maps', m.id, m);
    await refresh();
  };

  const newDraft = () => {
    setDraft({
      id: uid('quiz'), type: 'choice', question: '', options: ['', '', '', ''], correct: 0,
      answers: [], timeLimit: 30, createdAt: Date.now(),
    });
    setEditingId(null);
    sfx.click();
  };

  const editQuiz = (q: QuizDef) => {
    setDraft(JSON.parse(JSON.stringify(q)) as QuizDef);
    setEditingId(q.id);
    sfx.click();
  };

  const setOpt = (i: number, v: string) => {
    if (!draft) return;
    const opts = [...(draft.options ?? ['', '', '', ''])];
    opts[i] = v;
    setDraft({ ...draft, options: opts });
  };

  const setType = (t: QuizType) => {
    if (!draft) return;
    setDraft({ ...draft, type: t, options: draft.options ?? ['', '', '', ''], answers: draft.answers ?? [] });
    sfx.hover();
  };

  const onImg = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !f.type.startsWith('image/')) return;
    if (f.size > 1.5 * 1024 * 1024) { toast('Картинка слишком большая (до 1.5 МБ)', 'err'); return; }
    const url = await fileToDataUrl(f);
    setDraft((d) => (d ? { ...d, imageId: url } : d));
    sfx.coin();
  };

  const onAudio = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !f.type.startsWith('audio/')) { toast('Нужен аудиофайл', 'err'); return; }
    if (f.size > 5 * 1024 * 1024) { toast('Мелодия слишком большая (до 5 МБ)', 'err'); return; }
    const url = await fileToDataUrl(f);
    setDraft((d) => (d ? { ...d, audioId: url } : d));
    sfx.coin();
  };

  const saveDraft = async () => {
    if (!map || !draft) return;
    if (!draft.question.trim()) { sfx.fail(); toast('Напишите вопрос', 'err'); return; }
    const needsOptions = draft.type === 'choice' || draft.type === 'mystery';
    if (needsOptions && (draft.options ?? []).filter((o) => o.trim()).length < 2) {
      sfx.fail(); toast('Заполните хотя бы 2 варианта ответа', 'err'); return;
    }
    if ((draft.type === 'text' || draft.type === 'music') && (draft.answers ?? []).filter((a) => a.trim()).length === 0) {
      sfx.fail(); toast('Добавьте хотя бы один верный ответ', 'err'); return;
    }
    if (draft.type === 'music' && !draft.audioId) { sfx.fail(); toast('Загрузите мелодию', 'err'); return; }
    const clean: QuizDef = { ...draft, question: draft.question.trim() };
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.quizzes = nextMap.quizzes ?? [];
    const i = nextMap.quizzes.findIndex((q) => q.id === clean.id);
    if (i >= 0) nextMap.quizzes[i] = clean;
    else nextMap.quizzes.push(clean);
    setMap(nextMap);
    await persist(nextMap);
    setDraft(null);
    setEditingId(null);
    sfx.success();
    toast(`Квиз «${clean.question.slice(0, 28)}…» сохранён`, 'ok');
  };

  const delQuiz = async (id: string) => {
    if (!map) return;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.quizzes = (nextMap.quizzes ?? []).filter((q) => q.id !== id);
    setMap(nextMap);
    await persist(nextMap);
    toast('Квиз удалён', 'err');
  };

  const typeMeta = (t: QuizType) => TYPE_META.find((x) => x.key === t)!;

  if (!map) {
    return (
      <div className="h-full crt-grid-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="flex items-center gap-4 mb-6">
            <GhostBtn onClick={() => setScreen('editorsHub')}>{Ic.back(14)} Редакторы</GhostBtn>
            <h1 className="font-display text-2xl uppercase tracking-wider text-sky flex items-center gap-3">
              <span className="text-sky">{Ic.dice(22)}</span> Редактор квизов
            </h1>
          </div>
          <p className="text-[13px] text-dim mb-5 max-w-2xl">
            Выберите карту, затем создавайте вопросы. На ячейках типа «Квиз» (ставятся в редакторе карт) игроки получают
            случайный вопрос из этой колоды.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {maps.map((m) => (
              <button key={m.id} onClick={() => openMap(m)} className="text-left pixel-panel pixel-corners p-4 transition-transform hover:-translate-y-1 hover:border-edge2 cursor-pointer group">
                <div className="flex items-center justify-between">
                  <span className="font-display uppercase text-paper group-hover:text-gold transition-colors">{m.name}</span>
                  <span className="font-pixel text-[8px] text-sky">{(m.quizzes ?? []).length} кв.</span>
                </div>
                <div className="tick-label text-faint mt-2">
                  {m.cells.filter((c) => c.type === 'quiz').length} ячеек-квизов · {(m.quizzes ?? []).length} вопросов
                </div>
              </button>
            ))}
            {maps.length === 0 && (
              <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm col-span-full">
                Сначала создайте карту в редакторе карт.
                <div className="mt-3"><PxBtn color="teal" onClick={() => setScreen('mapEditor')}>{Ic.map(14)} В редактор карт</PxBtn></div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full crt-grid-bg flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3 border-b-[3px] border-edge bg-[rgba(7,9,18,0.7)] flex-wrap">
        <GhostBtn onClick={() => { setMap(null); setDraft(null); }}>{Ic.back(14)} Карты</GhostBtn>
        <h1 className="font-display text-lg uppercase tracking-wider text-sky flex items-center gap-2">{Ic.dice(18)} Квизы · {map.name}</h1>
        <span className="hud-chip pixel-corners px-3 py-1 font-display text-xs text-gold uppercase">
          Ячеек-квизов: {quizCellCount} · Вопросов: {quizzes.length}
        </span>
        <div className="ml-auto">
          <PxBtn color="sky" onClick={newDraft}>{Ic.plus(14)} Новый квиз</PxBtn>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {quizCellCount === 0 && (
          <div className="max-w-2xl mx-auto pixel-corners border-[3px] border-dashed border-edge p-5 text-center mb-5">
            <p className="text-[13px] text-dim">
              На карте нет ячеек типа «Квиз». Поставьте их инструментом «Тип» в редакторе карт — иначе вопросы не выпадут никому.
            </p>
          </div>
        )}

        <div className="max-w-3xl mx-auto space-y-5">
          {/* список квизов */}
          <Panel title={`Колода · ${quizzes.length}`} icon={Ic.dice(16)} accent="var(--color-sky)">
            <div className="p-3 space-y-2">
              {quizzes.map((q) => (
                <div key={q.id} className={`flex items-center gap-3 border-2 px-3 py-2.5 ${editingId === q.id ? 'border-sky bg-sky/5' : 'border-edge bg-panel'}`}>
                  <span className="font-pixel text-[7px] px-1.5 py-1 shrink-0" style={{ background: typeMeta(q.type).color, color: '#0a0c18' }}>
                    {typeMeta(q.type).label.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-[12px] uppercase text-paper truncate">{q.question}</div>
                    <div className="tick-label text-faint mt-0.5">
                      ⏱ {q.timeLimit} сек · {q.type === 'text' ? `${(q.answers ?? []).length} отв.` : `верный: ${(q.options ?? [])[q.correct ?? 0] ?? '—'}`}
                      {q.continueOnCorrect && <span className="text-teal"> · марафон</span>}
                      {q.noPenalty && <span className="text-sky"> · без штрафа</span>}
                    </div>
                  </div>
                  <button onClick={() => editQuiz(q)} className="text-faint hover:text-sky cursor-pointer" aria-label="Редактировать">{Ic.pen(15)}</button>
                  <button onClick={() => void delQuiz(q.id)} className="text-faint hover:text-coral cursor-pointer" aria-label="Удалить">{Ic.trash(15)}</button>
                </div>
              ))}
              {quizzes.length === 0 && (
                <div className="text-center py-6 text-dim text-sm">Колода пуста — нажмите «Новый квиз»</div>
              )}
            </div>
          </Panel>

          {/* редактор квиза */}
          {draft && (
            <Panel title={editingId ? 'Редактирование квиза' : 'Новый квиз'} icon={Ic.pen(16)} accent="var(--color-gold)">
              <div className="p-4 space-y-4">
                <Field label="Тип вопроса">
                  <div className="grid grid-cols-2 gap-2">
                    {TYPE_META.map((t) => (
                      <button
                        key={t.key}
                        onClick={() => setType(t.key)}
                        className={`text-left px-3 py-2 border-2 transition-colors cursor-pointer ${draft.type === t.key ? 'border-gold bg-gold/10' : 'border-edge hover:border-edge2'}`}
                      >
                        <div className="font-display text-[11px] uppercase" style={{ color: t.color }}>{t.label}</div>
                        <div className="text-[10px] text-dim mt-0.5">{t.hint}</div>
                      </button>
                    ))}
                  </div>
                </Field>

                <Field label="Время на ответ (секунды)">
                  <Stepper value={draft.timeLimit} onChange={(v) => setDraft({ ...draft, timeLimit: Math.max(5, Math.min(180, v)) })} min={5} max={180} suffix=" сек" />
                </Field>

                <div className="grid sm:grid-cols-2 gap-2">
                  <Toggle
                    checked={!!draft.continueOnCorrect}
                    onChange={(v) => setDraft({ ...draft, continueOnCorrect: v })}
                    label="Верный ответ не завершает квиз"
                    hint="Каждый ответивший верно сразу получает +5, квиз идёт, пока не ответят все"
                  />
                  <Toggle
                    checked={!!draft.noPenalty}
                    onChange={(v) => setDraft({ ...draft, noPenalty: v })}
                    label="Ошибка без штрафа"
                    hint="Неверный ответ не отнимает ресурсы (игрок всё равно выбывает из гонки)"
                  />
                </div>

                <Field label="Текст вопроса">
                  <textarea className="field-in w-full px-3 py-2 text-sm h-16 resize-none" value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} placeholder="Какой босс в Mega Man 2 стреляет пузырями?" />
                </Field>

                {draft.type !== 'music' && (
                  <Field label="Картинка к вопросу (необязательно)">
                    <div className="flex items-center gap-2">
                      <label className="btn-ghost pixel-corners px-3 py-2 text-[11px] uppercase font-display cursor-pointer inline-flex items-center gap-2">
                        {Ic.upload(13)} Загрузить
                        <input ref={imgRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onImg(e.target.files); e.target.value = ''; }} />
                      </label>
                      {draft.imageId && <img src={draft.imageId} alt="" className="h-12 w-16 object-cover border-2 border-edge" />}
                      {draft.imageId && <GhostBtn small onClick={() => setDraft({ ...draft, imageId: undefined })}>{Ic.trash(12)}</GhostBtn>}
                    </div>
                  </Field>
                )}

                {draft.type === 'music' && (
                  <Field label="Мелодия (игрок услышит её)">
                    <div className="flex items-center gap-2 flex-wrap">
                      <label className="btn-ghost pixel-corners px-3 py-2 text-[11px] uppercase font-display cursor-pointer inline-flex items-center gap-2">
                        {Ic.upload(13)} Загрузить аудио
                        <input ref={audioRef} type="file" accept="audio/*" className="hidden" onChange={(e) => { void onAudio(e.target.files); e.target.value = ''; }} />
                      </label>
                      {draft.audioId && <audio src={draft.audioId} controls className="h-9 max-w-[260px]" />}
                      {draft.audioId && <GhostBtn small onClick={() => setDraft({ ...draft, audioId: undefined })}>{Ic.trash(12)}</GhostBtn>}
                    </div>
                  </Field>
                )}

                {draft.type === 'text' || draft.type === 'music' ? (
                  <Field label="Верные ответы (каждый с новой строки — засчитается любое написание, регистр не важен)">
                    <textarea
                      className="field-in w-full px-3 py-2 text-sm h-20 resize-none font-mono"
                      value={(draft.answers ?? []).join('\n')}
                      onChange={(e) => setDraft({ ...draft, answers: e.target.value.split('\n') })}
                      placeholder={'Гейтмен\nGate Man\nGateMan'}
                    />
                  </Field>
                ) : (
                  <Field label="Варианты ответа (отметьте верный)">
                    <div className="space-y-2">
                      {(draft.options ?? ['', '', '', '']).map((opt, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <button
                            onClick={() => setDraft({ ...draft, correct: i })}
                            aria-label={`Верный вариант ${i + 1}`}
                            className={`w-8 h-8 shrink-0 border-2 font-display text-[11px] transition-colors cursor-pointer ${draft.correct === i ? 'border-teal text-teal bg-teal/10' : 'border-edge text-faint hover:text-dim'}`}
                          >
                            {['А', 'Б', 'В', 'Г'][i]}
                          </button>
                          <input className="field-in w-full px-3 py-2 text-sm" value={opt} onChange={(e) => setOpt(i, e.target.value)} placeholder={`Вариант ${['А', 'Б', 'В', 'Г'][i]}`} />
                        </div>
                      ))}
                    </div>
                  </Field>
                )}

                {draft.type === 'mystery' && (
                  <div className="hud-chip pixel-corners px-3 py-2 text-[11px] text-sky leading-relaxed">
                    «Кот в мешке»: вопрос автоматически передаётся случайному сопернику — отвечает он, бонус/штраф тоже получает он.
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <GhostBtn onClick={() => { setDraft(null); setEditingId(null); }}>Отмена</GhostBtn>
                  <PxBtn color="sky" onClick={() => void saveDraft()}>{Ic.check(14)} Сохранить квиз</PxBtn>
                </div>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
