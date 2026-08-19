import { useRef, useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Modal, Panel, PxBtn, Stepper } from '../ui';
import { fileToDataUrl } from '../assets';
import { idbDel, idbPut, uid } from '../db';
import type { TileDef } from '../types';
import { sfx } from '../sound';
import PixelPaint, { gridToDataUrl, imageToGrid } from '../PixelPaint';

interface SplitState {
  dataUrl: string;
  img: HTMLImageElement;
  name: string;
  cols: number;
  rows: number;
  gw: number;
  gh: number;
}

interface PaintState {
  tile: TileDef;
  grid: (string | null)[];
  w: number;
  h: number;
}

export const STD_FOLDER = 'Стандарт';

export default function TileEditor() {
  const { tiles, setScreen, refresh, toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const splitRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<{ dataUrl: string; name: string; gw: number; gh: number; folder: string } | null>(null);
  const [split, setSplit] = useState<SplitState | null>(null);
  const [paint, setPaint] = useState<PaintState | null>(null);
  const [folder, setFolder] = useState<string>(STD_FOLDER);

  const folderOf = (t: TileDef) => t.folder?.trim() || STD_FOLDER;
  const folders = Array.from(new Set([STD_FOLDER, ...tiles.map(folderOf)]));
  const inFolder = tiles.filter((t) => folderOf(t) === folder);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const f = files[0];
    if (!f.type.startsWith('image/')) { toast('Нужен файл изображения', 'err'); return; }
    const dataUrl = await fileToDataUrl(f);
    setDraft({ dataUrl, name: f.name.replace(/\.[^.]+$/, '').slice(0, 20), gw: 1, gh: 1, folder });
  };

  const onSplitFile = async (files: FileList | null) => {
    if (!files?.length) return;
    const f = files[0];
    if (!f.type.startsWith('image/')) { toast('Нужен файл изображения', 'err'); return; }
    const dataUrl = await fileToDataUrl(f);
    const img = new Image();
    img.onload = () => {
      setSplit({
        dataUrl, img,
        name: f.name.replace(/\.[^.]+$/, '').slice(0, 14).toUpperCase(),
        cols: 2, rows: 2, gw: 1, gh: 1,
      });
      sfx.coin();
    };
    img.src = dataUrl;
  };

  const addTile = async () => {
    if (!draft) return;
    const t: TileDef = {
      id: uid('tile'), name: draft.name || 'ТАЙЛ', gw: draft.gw, gh: draft.gh,
      dataUrl: draft.dataUrl, folder: draft.folder === STD_FOLDER ? undefined : draft.folder, createdAt: Date.now(),
    };
    await idbPut('tiles', t.id, t);
    await refresh();
    setDraft(null);
    sfx.coin();
    toast(`Тайл добавлен в папку «${draft.folder}»`, 'ok');
  };

  const cutPieces = async () => {
    if (!split) return;
    const { img, cols, rows, gw, gh, name } = split;
    const pw = Math.floor(img.width / cols);
    const ph = Math.floor(img.height / rows);
    if (pw < 4 || ph < 4) { toast('Клетки слишком маленькие — уменьшите сетку', 'err'); return; }
    const cv = document.createElement('canvas');
    cv.width = pw; cv.height = ph;
    const ctx = cv.getContext('2d')!;
    const now = Date.now();
    let n = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.clearRect(0, 0, pw, ph);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, c * pw, r * ph, pw, ph, 0, 0, pw, ph);
        const t: TileDef = {
          id: uid('tile'),
          name: `${name || 'НАБОР'}-${n + 1}`,
          gw, gh,
          dataUrl: cv.toDataURL('image/png'),
          folder: name || 'НАБОР',
          createdAt: now + n,
        };
        await idbPut('tiles', t.id, t);
        n++;
      }
    }
    await refresh();
    setSplit(null);
    setFolder(name || 'НАБОР');
    sfx.success();
    toast(`Готово: ${n} тайлов в папке «${name || 'НАБОР'}»`, 'ok');
  };

  const openPaint = (tile: TileDef) => {
    const img = new Image();
    img.onload = () => {
      const cap = 48;
      const scale = Math.min(1, cap / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      setPaint({ tile, grid: imageToGrid(img, w, h), w, h });
      sfx.click();
    };
    img.src = tile.dataUrl;
  };

  const savePaint = async () => {
    if (!paint) return;
    const updated: TileDef = {
      ...paint.tile,
      dataUrl: gridToDataUrl(paint.grid, paint.w, paint.h, Math.max(1, Math.round(64 / Math.max(paint.w, paint.h)))),
    };
    await idbPut('tiles', updated.id, updated);
    await refresh();
    setPaint(null);
    sfx.success();
    toast(`Тайл «${updated.name}» обновлён`, 'ok');
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
          <div className="ml-auto flex gap-2">
            <GhostBtn onClick={() => splitRef.current?.click()}>{Ic.grid(14)} Разрезать картинку</GhostBtn>
            <PxBtn color="lime" onClick={() => fileRef.current?.click()}>{Ic.upload(15)} Загрузить тайл</PxBtn>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
            <input ref={splitRef} type="file" accept="image/*" className="hidden" onChange={(e) => { void onSplitFile(e.target.files); e.target.value = ''; }} />
          </div>
        </div>
        <p className="text-[13px] text-dim mb-6 max-w-3xl">
          Тайл — кусок фона карты. Карту собирают из тайлов <span className="text-paper">одинакового клеточного размера</span> (поворот — в редакторе карт, клавиша R).
          Большую картинку можно <span className="text-lime">разрезать на сетку тайлов</span>, а любой тайл — точечно подправить во встроенном пиксель-редакторе.
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
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => openPaint(t)}
                      className="text-faint hover:text-lime transition-colors cursor-pointer"
                      aria-label={`Редактировать ${t.name}`}
                      title="Точечное редактирование"
                    >
                      {Ic.pen(15)}
                    </button>
                    <button
                      onClick={() => removeTile(t)}
                      className="text-faint hover:text-coral transition-colors cursor-pointer"
                      aria-label={`Удалить ${t.name}`}
                    >
                      {Ic.trash(15)}
                    </button>
                  </div>
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

      {/* новый тайл */}
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

      {/* разрезалка */}
      {split && (
        <Modal title="Разрезать картинку на тайлы" icon={Ic.grid(16)} onClose={() => setSplit(null)} w="max-w-2xl">
          <div className="grid md:grid-cols-[1fr_220px] gap-4">
            <div
              className="relative border-[3px] border-edge2 bg-[#0d1226] overflow-hidden"
              style={{ aspectRatio: `${split.img.width}/${split.img.height}`, maxHeight: 380 }}
            >
              <img src={split.dataUrl} alt="source" className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  backgroundImage:
                    'linear-gradient(to right, rgba(255,207,63,0.8) 2px, transparent 2px), linear-gradient(to bottom, rgba(255,207,63,0.8) 2px, transparent 2px)',
                  backgroundSize: `${100 / split.cols}% ${100 / split.rows}%`,
                }}
              />
              <div
                className="absolute inset-0 pointer-events-none border-2 border-gold"
                style={{ boxShadow: 'inset 0 0 0 999px rgba(255,207,63,0.05)' }}
              />
            </div>
            <div className="space-y-3">
              <Field label="Префикс названий">
                <input className="field-in w-full px-3 py-2 text-sm" value={split.name} onChange={(e) => setSplit({ ...split, name: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Колонок">
                <Stepper value={split.cols} onChange={(v) => setSplit({ ...split, cols: v })} min={1} max={12} />
              </Field>
              <Field label="Рядов">
                <Stepper value={split.rows} onChange={(v) => setSplit({ ...split, rows: v })} min={1} max={12} />
              </Field>
              <Field label="Клеток по X у тайла">
                <Stepper value={split.gw} onChange={(v) => setSplit({ ...split, gw: v })} min={1} max={6} suffix=" кл." />
              </Field>
              <Field label="Клеток по Y у тайла">
                <Stepper value={split.gh} onChange={(v) => setSplit({ ...split, gh: v })} min={1} max={6} suffix=" кл." />
              </Field>
              <div className="tick-label text-gold">
                Получится {split.cols * split.rows} тайлов «{split.name || 'НАБОР'}-1…{split.cols * split.rows}»
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-5">
            <GhostBtn onClick={() => setSplit(null)}>Отмена</GhostBtn>
            <PxBtn color="lime" onClick={() => void cutPieces()}>{Ic.check(14)} Разрезать</PxBtn>
          </div>
        </Modal>
      )}

      {/* пиксельная правка тайла */}
      {paint && (
        <Modal title={`Правка тайла «${paint.tile.name}»`} icon={Ic.pen(16)} onClose={() => setPaint(null)} w="max-w-2xl">
          <div className="space-y-3">
            <p className="text-[11px] text-dim">
              Точечное редактирование: карандаш, ластик, заливка. Крупные картинки редактируются в масштабе {paint.w}×{paint.h} px.
            </p>
            <PixelPaint grid={paint.grid} w={paint.w} h={paint.h} onChange={(g) => setPaint({ ...paint, grid: g })} checker={false} />
            <div className="flex justify-end gap-2">
              <GhostBtn onClick={() => setPaint(null)}>Отмена</GhostBtn>
              <PxBtn color="lime" onClick={() => void savePaint()}>{Ic.check(14)} Сохранить тайл</PxBtn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
