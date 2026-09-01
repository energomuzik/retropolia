import { useRef, useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Modal, Panel, PxBtn } from '../ui';
import PixelPaint, { emptyGrid, gridToDataUrl, imageToGrid } from '../PixelPaint';
import { fileToDataUrl } from '../assets';
import { idbDel, idbPut, uid } from '../db';
import type { TokenDef } from '../types';
import { sfx } from '../sound';

const SIZES = [12, 16, 24, 32];

export default function TokenEditor() {
  const { tokens, setScreen, refresh, toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState<{ grid: (string | null)[]; w: number; h: number; name: string } | null>(null);

  const newBlank = (size: number) => {
    setEditor({ grid: emptyGrid(size, size), w: size, h: size, name: 'ФИШКА' });
    sfx.click();
  };

  const onFile = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !f.type.startsWith('image/')) return;
    const dataUrl = await fileToDataUrl(f);
    const img = new Image();
    img.onload = () => {
      const size = SIZES.find((s) => s >= Math.max(img.width, img.height)) ?? 32;
      const grid = imageToGrid(img, Math.min(img.width, size), Math.min(img.height, size));
      setEditor({
        grid,
        w: Math.min(img.width, size),
        h: Math.min(img.height, size),
        name: f.name.replace(/\.[^.]+$/, '').slice(0, 16).toUpperCase(),
      });
      sfx.coin();
      toast('Картинка загружена в редактор — прозрачность сохранена, дорисуйте детали', 'ok');
    };
    img.src = dataUrl;
  };

  const save = async () => {
    if (!editor) return;
    const hasPixels = editor.grid.some(Boolean);
    if (!hasPixels) { toast('Нарисуйте что-нибудь — пустая фишка не сохранится', 'err'); return; }
    const t: TokenDef = {
      id: uid('tok'),
      name: editor.name.trim() || 'ФИШКА',
      dataUrl: gridToDataUrl(editor.grid, editor.w, editor.h, 4),
      createdAt: Date.now(),
    };
    await idbPut('tokens', t.id, t);
    await refresh();
    setEditor(null);
    sfx.success();
    toast(`Фишка «${t.name}» готова — выберите её в лобби перед игрой`, 'ok');
  };

  const remove = async (t: TokenDef) => {
    await idbDel('tokens', t.id);
    await refresh();
    toast(`Фишка «${t.name}» удалена`, 'err');
  };

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-2 flex-wrap">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-sky flex items-center gap-3">
            <span className="text-sky">{Ic.pawn(22)}</span> Редактор фишек
          </h1>
          <div className="ml-auto flex gap-2">
            <GhostBtn onClick={() => newBlank(16)}>{Ic.plus(14)} Нарисовать</GhostBtn>
            <PxBtn color="sky" onClick={() => fileRef.current?.click()}>{Ic.upload(15)} Загрузить PNG</PxBtn>
            <input ref={fileRef} type="file" accept="image/png,image/webp,image/gif" className="hidden" onChange={(e) => { void onFile(e.target.files); e.target.value = ''; }} />
          </div>
        </div>
        <p className="text-[13px] text-dim mb-6 max-w-3xl">
          Фишка — это фигурка игрока на поле. Загрузите PNG <span className="text-paper">с прозрачностью</span> или нарисуйте пиксель-арт
          во встроенном редакторе (ластик делает пиксели прозрачными). Перед партией каждый игрок выбирает фишку в лобби.
        </p>

        <Panel title={`Мои фишки · ${tokens.length}`} icon={Ic.pawn(16)} accent="var(--color-sky)">
          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
            {tokens.map((t) => (
              <div key={t.id} className="pixel-panel pixel-corners p-3 text-center transition-transform hover:-translate-y-1 hover:border-edge2">
                <div
                  className="mx-auto w-20 h-20 flex items-center justify-center border-2 border-edge"
                  style={{ background: 'conic-gradient(#1a2244 25%, #10142a 0 50%, #1a2244 0 75%, #10142a 0)', backgroundSize: '14px 14px' }}
                >
                  <img src={t.dataUrl} alt={t.name} className="max-w-full max-h-full" style={{ imageRendering: 'pixelated' }} />
                </div>
                <div className="font-display text-[11px] uppercase text-paper truncate mt-2">{t.name}</div>
                <div className="flex justify-center gap-2 mt-2">
                  <GhostBtn small onClick={() => newBlank(16)} className="!px-2">Новая</GhostBtn>
                  <button onClick={() => void remove(t)} className="text-faint hover:text-coral cursor-pointer" aria-label="Удалить фишку">
                    {Ic.trash(15)}
                  </button>
                </div>
              </div>
            ))}
            {tokens.length === 0 && (
              <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm col-span-full">
                Фишек пока нет — все играют стандартными роботами. Нарисуйте первую!
              </div>
            )}
          </div>
        </Panel>
      </div>

      {editor && (
        <Modal title="Пиксель-арт фишка" icon={Ic.pawn(16)} onClose={() => setEditor(null)} w="max-w-2xl">
          <div className="space-y-4">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-1 min-w-[180px]">
                <Field label="Название">
                  <input className="field-in w-full px-3 py-2 text-sm" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value.toUpperCase() })} />
                </Field>
              </div>
              <div>
                <span className="tick-label block mb-1.5">Новый холст</span>
                <div className="flex gap-1.5">
                  {SIZES.map((sz) => (
                    <button key={sz} onClick={() => newBlank(sz)} className="btn-ghost pixel-corners px-2.5 py-1.5 text-[11px] cursor-pointer">
                      {sz}²
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <PixelPaint grid={editor.grid} w={editor.w} h={editor.h} onChange={(g) => setEditor({ ...editor, grid: g })} />
            <div className="flex justify-end gap-2">
              <GhostBtn onClick={() => setEditor(null)}>Отмена</GhostBtn>
              <PxBtn color="sky" onClick={() => void save()}>{Ic.check(14)} Сохранить фишку</PxBtn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
