import { useRef, useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Modal, Panel, PxBtn, Stepper } from '../ui';
import { fileToDataUrl } from '../assets';
import { idbDel, idbPut, uid } from '../db';
import type { TileDef } from '../types';
import { sfx } from '../sound';

export default function TileEditor() {
  const { tiles, setScreen, refresh, toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{ dataUrl: string; name: string; gw: number; gh: number } | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const f = files[0];
    if (!f.type.startsWith('image/')) { toast('Нужен файл изображения', 'err'); return; }
    const dataUrl = await fileToDataUrl(f);
    setDraft({ dataUrl, name: f.name.replace(/\.[^.]+$/, '').slice(0, 20), gw: 1, gh: 1 });
  };

  const addTile = async () => {
    if (!draft) return;
    const t: TileDef = {
      id: uid('tile'), name: draft.name || 'ТАЙЛ', gw: draft.gw, gh: draft.gh,
      dataUrl: draft.dataUrl, createdAt: Date.now(),
    };
    await idbPut('tiles', t.id, t);
    await refresh();
    setDraft(null);
    sfx.coin();
    toast('Тайл добавлен в библиотеку', 'ok');
  };

  const removeTile = async (t: TileDef) => {
    await idbDel('tiles', t.id);
    await refresh();
    toast(`Тайл «${t.name}» удалён`, 'err');
  };

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-2 flex-wrap">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-lime flex items-center gap-3">
            <span className="text-lime">{Ic.grid(22)}</span> Редактор тайлов
          </h1>
          <div className="ml-auto">
            <PxBtn color="lime" onClick={() => fileRef.current?.click()}>{Ic.upload(15)} Загрузить тайл</PxBtn>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
          </div>
        </div>
        <p className="text-[13px] text-dim mb-6 max-w-3xl">
          Тайл — квадрат фона с рисунком. Карту можно собирать из тайлов <span className="text-paper">одинакового клеточного размера</span>:
          тайл 1×1 закрывает одну клетку, 2×1 — две и так далее. Поворот тайлов выполняется прямо в редакторе карт (клавиша R или кнопка).
        </p>

        <Panel title={`Библиотека · ${tiles.length}`} icon={Ic.grid(16)} accent="var(--color-lime)">
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {tiles.map((t) => (
              <div key={t.id} className="group pixel-panel pixel-corners p-2.5 transition-transform hover:-translate-y-1 hover:border-edge2">
                <div className="relative aspect-square bg-[#0d1226] border-2 border-edge overflow-hidden" style={{ imageRendering: 'pixelated' }}>
                  <img src={t.dataUrl} alt={t.name} className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
                  {t.builtin && (
                    <span className="absolute top-0 left-0 bg-teal text-abyss font-pixel text-[7px] px-1 py-0.5">SYS</span>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between gap-1">
                  <div className="min-w-0">
                    <div className="font-display text-[11px] uppercase tracking-wide text-paper truncate">{t.name}</div>
                    <div className="tick-label text-faint">{t.gw}×{t.gh} клет.</div>
                  </div>
                  <button
                    onClick={() => removeTile(t)}
                    className="text-faint hover:text-coral transition-colors shrink-0 cursor-pointer"
                    aria-label={`Удалить ${t.name}`}
                  >
                    {Ic.trash(15)}
                  </button>
                </div>
              </div>
            ))}
            <button
              onClick={() => fileRef.current?.click()}
              className="pixel-corners border-[3px] border-dashed border-edge hover:border-lime hover:text-lime text-faint transition-colors flex flex-col items-center justify-center gap-2 min-h-[130px] cursor-pointer"
            >
              {Ic.upload(22)}
              <span className="font-pixel text-[8px]">ДОБАВИТЬ</span>
            </button>
          </div>
        </Panel>
      </div>

      {draft && (
        <Modal title="Новый тайл" icon={Ic.grid(16)} onClose={() => setDraft(null)} w="max-w-md">
          <div className="flex gap-4 items-start">
            <img src={draft.dataUrl} alt="preview" className="w-28 h-28 object-cover border-[3px] border-edge bg-[#0d1226]" style={{ imageRendering: 'pixelated' }} />
            <div className="flex-1 space-y-3">
              <Field label="Название">
                <input className="field-in w-full px-3 py-2 text-sm" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Размер по X (в клетках)">
                <Stepper value={draft.gw} onChange={(v) => setDraft({ ...draft, gw: v })} min={1} max={6} suffix=" кл." />
              </Field>
              <Field label="Размер по Y (в клетках)">
                <Stepper value={draft.gh} onChange={(v) => setDraft({ ...draft, gh: v })} min={1} max={6} suffix=" кл." />
              </Field>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-5">
            <GhostBtn onClick={() => setDraft(null)}>Отмена</GhostBtn>
            <PxBtn color="lime" onClick={addTile}>{Ic.check(14)} Добавить</PxBtn>
          </div>
        </Modal>
      )}
    </div>
  );
}
