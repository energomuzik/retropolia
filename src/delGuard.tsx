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

/* подсказка при неудавшемся коротком нажатии в режиме «долгое нажатие» */
export const holdHint = (toast: (m: string, k?: 'ok' | 'err' | 'info') => void) =>
  toast('Держите кнопку нажатой, пока полоска не заполнится — тогда удалю', 'info');

export { HOLD_MS };
