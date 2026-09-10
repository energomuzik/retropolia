import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from './store';
import { GhostBtn, Ic, Modal, PxBtn } from './ui';
import { sfx } from './sound';

/* ---------- ЗАЩИТА ОТ СЛУЧАЙНОГО УДАЛЕНИЯ + ОТМЕНА (Ctrl+Z) ----------
   Режим удаления задаётся в Опциях (options.delMode):
   • instant — клик удаляет сразу (как раньше)
   • confirm — клик открывает окошко с предупреждением (по умолчанию)
   • hold    — удалить можно, только удерживая крестик ~0.8 с
   Каждое удаление через rememberDeleted() запоминается — Ctrl+Z возвращает
   ПОСЛЕДНЮЮ удалённую вещь (один шаг, глубже не храним).
   ВАЖНО: если в className передан absolute — НЕ добавляем свой relative,
   иначе Tailwind (relative в CSS идёт позже absolute) сломает позиционирование
   крестика на тайле, и он исчезнет из угла (так было в v0.20.0). */

const HOLD_MS = 800;

export interface DeletedEntry {
  label: string; // что удалили — для тоста «Возвращено: …»
  restore: () => Promise<void>;
}

let lastDeleted: DeletedEntry | null = null;

export const rememberDeleted = (e: DeletedEntry) => {
  lastDeleted = e;
};

export const peekDeleted = (): DeletedEntry | null => lastDeleted;

/** Ctrl+Z: вернуть последнюю удалённую вещь. Возвращает запись или null. */
export const undoLastDelete = async (): Promise<DeletedEntry | null> => {
  const e = lastDeleted;
  lastDeleted = null;
  if (e) await e.restore();
  return e;
};

/* ---------- кнопка-крестик/урна, подчиняющаяся режиму из опций ---------- */
export function HoldDeleteButton({
  onFire,
  label,
  title = 'Удалить',
  ariaLabel = 'Удалить',
  className = 'text-faint hover:text-coral cursor-pointer transition-colors',
  children,
  as = 'button', // span — когда крестик лежит ВНУТРИ другой кнопки (например, на превью тайла)
}: {
  onFire: () => void; // само удаление (внутри: rememberDeleted + удаление)
  label: string; // что удаляем — для окошка и подсказок
  title?: string;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
  as?: 'button' | 'span';
}) {
  const delMode = useApp((s) => s.options.delMode);
  const toast = useApp((s) => s.toast);
  const [confirming, setConfirming] = useState(false);
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<number | null>(null);

  const fire = () => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    setHolding(false);
    setConfirming(false);
    sfx.fail();
    onFire();
  };

  const startHold = () => {
    setHolding(true);
    timerRef.current = window.setTimeout(fire, HOLD_MS);
  };
  /* отпустил раньше времени — тихо отменяем; если это был короткий клик по кнопке — подсказка */
  const endHold = (hint: boolean) => {
    const pending = timerRef.current !== null;
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    setHolding(false);
    if (hint && pending) holdHint(toast);
  };
  const cancelHold = () => endHold(false);

  const modeTitle =
    delMode === 'hold' ? 'Удерживайте, чтобы удалить' :
    delMode === 'confirm' ? `${title} (с подтверждением)` : title;

  /* если вызывающий сам задаёт позиционирование (absolute) — не мешаем ему:
     свой relative добавляем только когда его нет, иначе Tailwind сломает позиционирование */
  const isAbsolute = /(?:^|\s)absolute(?:\s|$)/.test(className);
  const posCls = isAbsolute ? '' : 'relative ';
  const fillCls = 'absolute left-0 top-0 h-full'; // полоска заполнения при удержании

  const inner = (
    <>
      <span className={`relative z-10 inline-flex ${holding ? 'text-coral' : ''}`}>{children}</span>
      {delMode === 'hold' && (
        <span
          aria-hidden
          className={`bg-[rgba(255,93,115,0.35)] pointer-events-none ${fillCls}`}
          style={{ width: holding ? '100%' : '0%', transition: `width ${HOLD_MS}ms linear` }}
        />
      )}
    </>
  );

  const handlers =
    delMode === 'hold'
      ? {
          onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); startHold(); },
          onPointerUp: () => endHold(true),
          onPointerLeave: cancelHold,
          onPointerCancel: cancelHold,
        }
      : {
          onClick: delMode === 'instant' ? fire : () => { setConfirming(true); sfx.hover(); },
        };

  const tag = as === 'span'
    ? (
        <span
          {...spanHandlers(handlers)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && delMode !== 'instant') { e.preventDefault(); e.stopPropagation(); setConfirming(true); } }}
          title={modeTitle}
          aria-label={ariaLabel}
          className={`${posCls}overflow-hidden shrink-0 ${className}`}
        >
          {inner}
        </span>
      )
    : (
        <button
          {...handlers}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && delMode !== 'instant') { e.preventDefault(); setConfirming(true); } }}
          title={modeTitle}
          aria-label={ariaLabel}
          className={`${posCls}overflow-hidden shrink-0 ${className}`}
        >
          {inner}
        </button>
      );

  /* Окошко подтверждения рисуем ЧЕРЕЗ ПОРТАЛ в body: если кнопка лежит внутри
     другой кнопки (крестик на тайле) или внутри элемента с transform
     (hover:scale-105), обычный fixed-модал обрезается/съезжает. Плюс
     stopPropagation — чтобы клики по окошку не «нажали» родительскую кнопку тайла. */
  return (
    <>
      {tag}

      {confirming && delMode !== 'instant' && createPortal(
        <div onClick={(e) => e.stopPropagation()}>
          <Modal title="Подтвердите удаление" icon={<span className="text-coral">{Ic.trash(18)}</span>} onClose={() => setConfirming(false)} w="max-w-md">
            <div className="p-5 space-y-4">
              <p className="text-[13px] text-paper leading-relaxed">
                Удалить <span className="text-coral font-display uppercase">{label}</span>?
              </p>
              <p className="text-[11px] text-dim leading-relaxed">
                Случайно удалили? Ctrl+Z вернёт последнюю удалённую вещь (на один шаг назад).
              </p>
              <div className="flex justify-end gap-2">
                <GhostBtn onClick={() => { sfx.hover(); setConfirming(false); }}>Отмена</GhostBtn>
                <PxBtn color="coral" onClick={fire}>{Ic.trash(14)} Удалить</PxBtn>
              </div>
            </div>
          </Modal>
        </div>,
        document.body,
      )}
    </>
  );
}

/* крестик ВНУТРИ другой кнопки: глушим всплытие, чтобы родитель не открыл тайл */
const spanHandlers = (h: Record<string, unknown>): Record<string, unknown> => ({
  ...h,
  onClick: (e: React.MouseEvent) => { e.stopPropagation(); (h.onClick as ((ev: React.MouseEvent) => void) | undefined)?.(e); },
  onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); (h.onPointerDown as ((ev: React.PointerEvent) => void) | undefined)?.(e); },
  onPointerUp: (e: React.PointerEvent) => { e.stopPropagation(); (h.onPointerUp as ((ev: React.PointerEvent) => void) | undefined)?.(e); },
});

/* ---------- удаление С КЛАВИАТУРЫ (Delete/Backspace), подчиняющееся режиму из опций ----------
   • instant — удаляем сразу
   • confirm — открываем такое же окошко подтверждения, как у крестиков
   • hold    — держим клавишу ~0.8 с: внизу экрана растёт полоска; отпустил раньше — удаления нет
   Вызов: keyDeleteStart(label, fire) на keydown (не e.repeat!), keyDeleteCancel(true) на keyup,
   keyDeleteCancel(false) при потере фокуса окна. node кладём в JSX (рисует окошко и полоску). */
export function useKeyDelete() {
  const delMode = useApp((s) => s.options.delMode);
  const toast = useApp((s) => s.toast);
  const [confirming, setConfirming] = useState<{ label: string } | null>(null);
  const [holding, setHolding] = useState<{ label: string } | null>(null);
  const timerRef = useRef<number | null>(null);
  const fireRef = useRef<(() => void) | null>(null);

  const clearTimer = () => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const doFire = () => {
    const f = fireRef.current;
    fireRef.current = null;
    clearTimer();
    setHolding(null);
    setConfirming(null);
    sfx.fail();
    f?.();
  };

  const keyDeleteStart = (label: string, fire: () => void) => {
    fireRef.current = fire;
    if (delMode === 'instant') { doFire(); return; }
    if (delMode === 'confirm') { setConfirming({ label }); sfx.hover(); return; }
    // hold: клавиша зажата — полоска внизу экрана; если keyup не придёт (окно потеряли) — удаление свершится
    setHolding({ label });
    clearTimer();
    timerRef.current = window.setTimeout(doFire, HOLD_MS);
  };
  /* keyup: отменяем удержание; если это был короткий клик по клавише — подсказка */
  const keyDeleteCancel = (hint: boolean) => {
    const pending = timerRef.current !== null;
    clearTimer();
    setHolding(null);
    if (hint && pending) holdHint(toast);
  };

  const node = (
    <>
      {confirming && createPortal(
        <Modal title="Подтвердите удаление" icon={<span className="text-coral">{Ic.trash(18)}</span>} onClose={() => { setConfirming(null); fireRef.current = null; }} w="max-w-md">
          <div className="p-5 space-y-4">
            <p className="text-[13px] text-paper leading-relaxed">
              Удалить <span className="text-coral font-display uppercase">{confirming.label}</span>?
            </p>
            <p className="text-[11px] text-dim leading-relaxed">
              Случайно удалили? Ctrl+Z вернёт последнюю удалённую вещь (на один шаг назад).
            </p>
            <div className="flex justify-end gap-2">
              <GhostBtn onClick={() => { sfx.hover(); setConfirming(null); fireRef.current = null; }}>Отмена</GhostBtn>
              <PxBtn color="coral" onClick={doFire}>{Ic.trash(14)} Удалить</PxBtn>
            </div>
          </div>
        </Modal>,
        document.body,
      )}
      {holding && createPortal(
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[98] pointer-events-none">
          <div className="pixel-panel pixel-corners px-4 py-2.5 min-w-[280px]">
            <div className="font-display text-[10px] uppercase text-paper text-center">Удаление: {holding.label}</div>
            <div className="mt-1.5 h-1.5 bg-[rgba(255,255,255,0.08)] relative overflow-hidden">
              <div className="absolute left-0 top-0 h-full bg-coral" style={{ width: '100%', transformOrigin: 'left', animation: `delhold ${HOLD_MS}ms linear forwards` }} />
            </div>
            <div className="tick-label text-faint text-center mt-1">держите Delete, пока полоска не заполнится</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );

  return { keyDeleteStart, keyDeleteCancel, node };
}

/* подсказка при неудавшемся коротком нажатии в режиме «долгое нажатие» */
export const holdHint = (toast: (m: string, k?: 'ok' | 'err' | 'info') => void) =>
  toast('Держите кнопку нажатой, пока полоска не заполнится — тогда удалю', 'info');

export { HOLD_MS };
