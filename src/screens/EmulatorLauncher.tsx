import { useEffect, useRef, useState } from 'react';
import { useApp, getRomData } from '../store';
import { Field, GhostBtn, Ic, Panel, PxBtn } from '../ui';
import NesBox, { type NesApi } from '../NesBox';
import { idbDel, idbPut, uid } from '../db';
import type { RomDef, SaveDef } from '../types';
import { sfx } from '../sound';

const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);

export default function EmulatorLauncher() {
  const { roms, saves, setScreen, refresh, toast } = useApp();
  const [romId, setRomId] = useState<string | null>(null);
  const [romBuf, setRomBuf] = useState<ArrayBuffer | null>(null);
  const [runKey, setRunKey] = useState(0);
  const [runState, setRunState] = useState<unknown>(undefined);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const apiRef = useRef<NesApi | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const rom = roms.find((r) => r.id === romId) ?? null;
  const romSaves = saves.filter((s) => s.romId === romId).sort((a, b) => a.slot - b.slot);

  const onUpload = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const ext = (f.name.split('.').pop() ?? '').toLowerCase();
    const isNes = ext === 'nes';
    const isSega = ['md', 'gen', 'sms', 'bin'].includes(ext);
    if (!isNes && !isSega) { toast('Поддерживаются .nes (NES) и .md/.gen/.sms (SEGA)', 'err'); return; }
    const buf = await f.arrayBuffer();
    const r: RomDef = {
      id: uid('rom'), name: f.name.replace(/\.[^.]+$/, ''), fileName: f.name,
      ext: isNes ? 'nes' : 'sega', size: f.size, createdAt: Date.now(),
    };
    await idbPut('roms', r.id, r);
    await idbPut('blobs', `rom-${r.id}`, buf);
    await refresh();
    setRomId(r.id);
    setRunning(false);
    sfx.coin();
    toast(isNes ? `Ром «${r.name}» загружен` : `Ром SEGA «${r.name}» сохранён (ядро SEGA в разработке)`, 'ok');
  };

  const launch = async (state?: unknown) => {
    if (!romId) return;
    const buf = await getRomData(romId);
    if (!buf) { toast('Данные рома не найдены — загрузите файл заново', 'err'); return; }
    setRomBuf(buf);
    setRunState(state);
    setRunning(true);
    setErr(null);
    setRunKey((k) => k + 1);
    sfx.start();
  };

  const createSave = async () => {
    if (!rom || !apiRef.current) return;
    const st = apiRef.current.snapshot();
    if (!st) { toast('Не удалось снять состояние', 'err'); return; }
    const slot = romSaves.length ? Math.max(...romSaves.map((s) => s.slot)) + 1 : 1;
    const sv: SaveDef = { id: uid('save'), romId: rom.id, slot, name: `Уровень ~${slot}`, state: st, createdAt: Date.now() };
    await idbPut('saves', sv.id, sv);
    await refresh();
    sfx.success();
    toast(`Сохранение (слот ${slot}) записано`, 'ok');
  };

  const delRom = async (r: RomDef) => {
    const linked = saves.filter((s) => s.romId === r.id);
    await Promise.all(linked.map((s) => idbDel('saves', s.id)));
    await idbDel('roms', r.id);
    await idbDel('blobs', `rom-${r.id}`);
    if (romId === r.id) { setRomId(null); setRunning(false); }
    await refresh();
    toast(`Ром «${r.name}» и его сохранения удалены`, 'err');
  };

  const delSave = async (s: SaveDef) => {
    await idbDel('saves', s.id);
    await refresh();
    sfx.fail();
    toast(`Сохранение (слот ${s.slot}) удалено`, 'err');
  };

  useEffect(() => () => { setRunning(false); }, []);

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-2 flex-wrap">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-coral flex items-center gap-3">
            <span className="text-coral">{Ic.chip(22)}</span> Запуск эмулятора
          </h1>
          <PxBtn color="coral" className="ml-auto" onClick={() => fileRef.current?.click()}>{Ic.upload(15)} Загрузить ром</PxBtn>
          <input ref={fileRef} type="file" accept=".nes,.md,.gen,.sms,.bin" className="hidden" onChange={(e) => { void onUpload(e.target.files); e.target.value = ''; }} />
        </div>
        <p className="text-[13px] text-dim mb-6 max-w-3xl">
          Тестовый стенд: гоняйте ромы, проходите до нужного места и жмите <span className="text-gold font-display uppercase">«Сохранить состояние»</span> —
          слоты потом выбираются в редакторе заданий. Неверные сохранения можно удалять.
        </p>

        <div className="grid lg:grid-cols-[300px_1fr] gap-5">
          <Panel title={`Ромы · ${roms.length}`} icon={Ic.cart(16)} accent="var(--color-coral)">
            <div className="p-2.5 space-y-1.5 max-h-[420px] overflow-y-auto">
              {roms.map((r) => (
                <div key={r.id} className={`border-2 px-3 py-2 transition-colors ${romId === r.id ? 'border-coral bg-coral/10' : 'border-edge bg-panel hover:border-edge2'}`}>
                  <button className="w-full text-left cursor-pointer" onClick={() => { setRomId(r.id); setRunning(false); sfx.hover(); }}>
                    <div className="flex items-center gap-2">
                      <span className={`font-pixel text-[7px] px-1 py-0.5 ${r.ext === 'nes' ? 'bg-sky text-abyss' : 'bg-magma text-abyss'}`}>{r.ext.toUpperCase()}</span>
                      <span className="font-display text-[12px] uppercase text-paper truncate">{r.name}</span>
                    </div>
                    <div className="tick-label text-faint mt-1">{fmtSize(r.size)} · сохранений: {saves.filter((s) => s.romId === r.id).length}</div>
                  </button>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="tick-label text-faint">{r.fileName}</span>
                    <button onClick={() => void delRom(r)} className="text-faint hover:text-coral cursor-pointer" aria-label="Удалить ром">{Ic.trash(14)}</button>
                  </div>
                </div>
              ))}
              {roms.length === 0 && (
                <div className="text-center py-8 px-3">
                  <span className="text-coral inline-block floaty">{Ic.cart(36)}</span>
                  <p className="text-[12px] text-dim mt-3">Загрузите файл .nes — и вперёд</p>
                </div>
              )}
            </div>
          </Panel>

          <div className="space-y-5">
            <Panel title={rom ? `${rom.name} · ${rom.ext.toUpperCase()}` : 'Экран'} icon={Ic.play(16)} accent="var(--color-teal)">
              <div className="p-4">
                {!running || !romBuf ? (
                  <div className="aspect-[256/120] max-h-[220px] w-full bg-[#05070f] border-[3px] border-edge flex flex-col items-center justify-center gap-3 relative overflow-hidden">
                    <div className="absolute inset-0 starfield opacity-40" />
                    {rom ? (
                      <>
                        <span className="font-pixel text-[10px] text-dim relative z-10">PRESS START</span>
                        <div className="flex gap-3 relative z-10">
                          <PxBtn color="teal" onClick={() => void launch()} disabled={rom.ext !== 'nes'}>{Ic.play(14)} Запустить с начала</PxBtn>
                        </div>
                        {rom.ext !== 'nes' && <span className="tick-label text-magma relative z-10">Ядро SEGA подключается — ром сохранён для заданий</span>}
                      </>
                    ) : (
                      <span className="font-pixel text-[9px] text-faint relative z-10">ВЫБЕРИТЕ ИЛИ ЗАГРУЗИТЕ РОМ</span>
                    )}
                  </div>
                ) : (
                  <div className="max-w-[560px] mx-auto">
                    <NesBox
                      key={runKey}
                      romData={romBuf}
                      initialState={runState}
                      enabled
                      onApi={(a) => { apiRef.current = a; }}
                    />
                    <div className="flex gap-2 mt-3 flex-wrap">
                      <PxBtn color="gold" onClick={() => void createSave()}>{Ic.save(14)} Сохранить состояние</PxBtn>
                      <GhostBtn onClick={() => void launch()}>{Ic.rotate(13)} Сброс (с начала)</GhostBtn>
                      <GhostBtn onClick={() => setRunning(false)}>{Ic.pause(13)} Выключить</GhostBtn>
                    </div>
                  </div>
                )}
                {err && <div className="mt-3 text-coral text-[12px]">{err}</div>}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-dim">
                  <div className="hud-chip pixel-corners px-2 py-1.5">Стрелки — крестовина</div>
                  <div className="hud-chip pixel-corners px-2 py-1.5">X — A · Z — B</div>
                  <div className="hud-chip pixel-corners px-2 py-1.5">Enter — Start</div>
                  <div className="hud-chip pixel-corners px-2 py-1.5">Shift — Select</div>
                </div>
              </div>
            </Panel>

            {rom && (
              <Panel title={`Сохранения «${rom.name}» · ${romSaves.length}`} icon={Ic.save(16)}>
                <div className="p-3 grid sm:grid-cols-2 gap-2">
                  {romSaves.map((s) => (
                    <div key={s.id} className="border-2 border-edge bg-panel px-3 py-2.5 flex items-center gap-3">
                      <span className="font-pixel text-[9px] text-gold shrink-0">S{s.slot}</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-display text-[11px] uppercase text-paper truncate">{s.name}</div>
                        <div className="tick-label text-faint">{new Date(s.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                      </div>
                      <GhostBtn small onClick={() => void launch(s.state)} disabled={rom.ext !== 'nes'}>{Ic.play(11)}</GhostBtn>
                      <button onClick={() => void delSave(s)} className="text-faint hover:text-coral cursor-pointer" aria-label="Удалить сохранение">{Ic.trash(14)}</button>
                    </div>
                  ))}
                  {romSaves.length === 0 && <div className="text-[12px] text-dim sm:col-span-2 py-3 text-center">Сохранений нет — запустите ром и запишите первое состояние</div>}
                </div>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
