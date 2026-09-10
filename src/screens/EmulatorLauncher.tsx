import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, getRomData } from '../store';
import { EmuVolumeChip, Field, GhostBtn, Ic, Panel, PxBtn } from '../ui';
import SegaBox, { type SegaApi } from '../SegaBox';
import KeyBinder from '../KeyBinder';
import { idbDel, idbPut, uid } from '../db';
import type { RomDef, SaveDef } from '../types';
import { HoldDeleteButton, rememberDeleted } from '../delGuard';
import {
  keyLabel, loadEmuPrefs, PREFS_EVENT, listGamepads,
  PAD_ACTIONS, NES_TO_RETRO, codeToEjsKey,
  SEGA_ACTIONS, SEGA_TO_RETRO,
} from '../input';
import { sfx } from '../sound';

const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);

/* пустые папки ромов (без ромов) — в localStorage, чтобы пустая папка не исчезала */
const ROM_FOLDERS_KEY = 'retropolia-rom-folders';
const loadEmptyRomFolders = (): string[] => {
  try {
    const raw = localStorage.getItem(ROM_FOLDERS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch { return []; }
};
const saveEmptyRomFolders = (arr: string[]) => {
  try { localStorage.setItem(ROM_FOLDERS_KEY, JSON.stringify(arr)); } catch { /* приватный режим — переживём */ }
};

export default function EmulatorLauncher() {
  const { roms, saves, setScreen, refresh, toast } = useApp();
  const [romId, setRomId] = useState<string | null>(null);
  const [romBuf, setRomBuf] = useState<ArrayBuffer | null>(null);
  const [runKey, setRunKey] = useState(0);
  const [runState, setRunState] = useState<unknown>(undefined);
  const [running, setRunning] = useState(false);
  const [, forceUi] = useState(0);
  // единый API эмулятора EmulatorJS (и NES, и SEGA)
  const ejsApiRef = useRef<SegaApi | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // какой ром сейчас реально крутится в эмуляторе (для загрузки сохранений без перезапуска)
  const launchedRomRef = useRef<string | null>(null);
  // наш редактор управления (открывается кнопкой «Управление» рядом с эмулятором)
  const [controlsOpen, setControlsOpen] = useState(false);
  // папки ромов: выбранная папка для загрузки + какие спойлеры свернуты + пустые папки (localStorage)
  const [uploadFolder, setUploadFolder] = useState(''); // '' — «Без папки»
  const [newFolderOpen, setNewFolderOpen] = useState(false); // строка создания новой папки
  const [newFolderName, setNewFolderName] = useState('');
  const [emptyFolders, setEmptyFolders] = useState<string[]>(loadEmptyRomFolders);
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const setEmptyFoldersSaved = (updater: (prev: string[]) => string[]) => {
    setEmptyFolders((prev) => {
      const next = updater(prev);
      saveEmptyRomFolders(next);
      return next;
    });
  };
  const addEmptyRomFolder = (name: string) => setEmptyFoldersSaved((prev) => (prev.includes(name) ? prev : [...prev, name]));
  const removeEmptyRomFolder = (name: string) => setEmptyFoldersSaved((prev) => prev.filter((x) => x !== name));

  const rom = roms.find((r) => r.id === romId) ?? null;
  const isNes = rom?.ext === 'nes';
  const romSaves = saves.filter((s) => s.romId === romId).sort((a, b) => a.slot - b.slot);

  /* группировка ромов по папкам (спойлеры, как у тайлов в редакторах);
     ромы без папки показываются отдельным списком «Без папки».
     В списке и пустые папки (созданные кнопкой «+ Папка» и ещё не заполненные) */
  const folderNames = useMemo(
    () => [...new Set([...emptyFolders, ...roms.map((r) => r.folder ?? '').filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'ru')),
    [roms, emptyFolders],
  );
  const looseRoms = useMemo(() => roms.filter((r) => !r.folder), [roms]);
  const romsIn = (folder: string) => roms.filter((r) => r.folder === folder);

  /* Раскладка пользователя → «мост»: клавиша пользователя → клавиша ядра.
     Клавиши ядра читаются из самого EmulatorJS при старте — переназначение не
     трогает внутренние настройки ядра и не может их сломать. */
  const [prefsTick, setPrefsTick] = useState(0);
  useEffect(() => {
    const bump = () => setPrefsTick((x) => x + 1);
    window.addEventListener(PREFS_EVENT, bump);
    return () => window.removeEventListener(PREFS_EVENT, bump);
  }, []);
  const remapSpec = useMemo(() => {
    const p = loadEmuPrefs();
    const spec: { idx: number; key: string }[] = [];
    if (isNes) {
      for (const a of PAD_ACTIONS) {
        const idx = NES_TO_RETRO[a];
        if (idx !== undefined && p.keys[a]) spec.push({ idx, key: codeToEjsKey(p.keys[a]) });
      }
    } else {
      for (const a of SEGA_ACTIONS) {
        const idx = SEGA_TO_RETRO[a];
        if (idx !== undefined && p.segaKeys[a]) spec.push({ idx, key: p.segaKeys[a].toLowerCase() });
      }
    }
    return spec;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNes, prefsTick, runKey]);

  useEffect(() => {
    const bump = () => forceUi((x) => x + 1);
    window.addEventListener(PREFS_EVENT, bump);
    window.addEventListener('gamepadconnected', bump);
    window.addEventListener('gamepaddisconnected', bump);
    const t = setInterval(bump, 900);
    return () => {
      window.removeEventListener(PREFS_EVENT, bump);
      window.removeEventListener('gamepadconnected', bump);
      window.removeEventListener('gamepaddisconnected', bump);
      clearInterval(t);
    };
  }, []);

  /* загрузка СРАЗУ НЕСКОЛЬКИХ ромов в выбранную папку (select над кнопкой) */
  const onUpload = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const folder = uploadFolder.trim().slice(0, 24);
    let lastId: string | null = null;
    let loaded = 0, skipped = 0;
    for (const f of list) {
      const ext = (f.name.split('.').pop() ?? '').toLowerCase();
      const isNesFile = ext === 'nes';
      const isSegaFile = ['md', 'gen', 'sms', 'gg', 'bin'].includes(ext);
      if (!isNesFile && !isSegaFile) { skipped++; continue; }
      const buf = await f.arrayBuffer();
      const r: RomDef = {
        id: uid('rom'), name: f.name.replace(/\.[^.]+$/, ''), fileName: f.name,
        ext: isNesFile ? 'nes' : 'sega', size: f.size, createdAt: Date.now(),
        ...(folder ? { folder } : {}),
      };
      await idbPut('roms', r.id, r);
      await idbPut('blobs', `rom-${r.id}`, buf);
      lastId = r.id;
      loaded++;
    }
    if (!loaded) { toast('Нет поддерживаемых файлов: .nes (NES) и .md/.gen/.sms/.gg/.bin (SEGA)', 'err'); return; }
    if (folder) removeEmptyRomFolder(folder); // папка больше не пустая
    await refresh();
    if (lastId) setRomId(lastId);
    setRunning(false);
    sfx.coin();
    toast(skipped ? `Ромов загружено: ${loaded} → папка «${folder || 'Без папки'}» · пропущено чужих: ${skipped}` : `Ромов загружено: ${loaded}${folder ? ` → папка «${folder}»` : ''}`, 'ok');
  };

  /* создать папку: имя вводится в строке под списком; пустая папка хранится в localStorage */
  const createRomFolder = () => {
    const name = newFolderName.trim().slice(0, 24);
    if (!name) { toast('Введите название папки', 'err'); return; }
    if (folderNames.includes(name)) { toast('Такая папка уже есть', 'err'); return; }
    addEmptyRomFolder(name);
    setUploadFolder(name); // сразу выбрана — можно заливать ромы
    setNewFolderName('');
    setNewFolderOpen(false);
    sfx.coin();
    toast(`Папка «${name}» создана — загрузите в неё ромы`, 'ok');
  };

  const launch = async (state?: unknown) => {
    if (!romId) return;
    const buf = await getRomData(romId);
    if (!buf) { toast('Данные рома не найдены — загрузите файл заново', 'err'); return; }
    setRomBuf(buf);
    setRunState(state);
    setRunning(true);
    launchedRomRef.current = romId;
    setRunKey((k) => k + 1);
    sfx.start();
  };

  // Загрузка сохранения: перезапуск ядра с применением состояния через
  // документированный EJS_loadStateURL (NES и SEGA — единый путь). Ядро при этом
  // берётся из кэша браузера, поэтому перезапуск быстрый и без повторного скачивания.
  const loadSave = (s: SaveDef) => {
    if (rom && running && ejsApiRef.current) {
      ejsApiRef.current.loadSaveReliable(s.state as string);
      setRunState(s.state);
      sfx.coin();
      toast(`Загружаю сохранение (слот ${s.slot})…`, 'ok');
      return;
    }
    void launch(s.state);
  };

  // Сброс: перезапуск ядра с начала (без состояния).
  const resetEmu = () => {
    if (rom && running && ejsApiRef.current) {
      ejsApiRef.current.loadSaveReliable(null);
      setRunState(undefined);
      sfx.click();
      return;
    }
    void launch();
  };

  const createSave = async () => {
    if (!rom) return;
    const st = (await ejsApiRef.current?.snapshot()) ?? null;
    if (!st) { toast('Эмулятор ещё не готов — дайте игре запуститься и попробуйте снова', 'err'); return; }
    const slot = romSaves.length ? Math.max(...romSaves.map((s) => s.slot)) + 1 : 1;
    const sv: SaveDef = { id: uid('save'), romId: rom.id, slot, name: `Уровень ~${slot}`, state: st, createdAt: Date.now() };
    await idbPut('saves', sv.id, sv);
    await refresh();
    sfx.success();
    toast(`Сохранение (слот ${slot}) записано`, 'ok');
  };

  const delRom = async (r: RomDef) => {
    // для Ctrl+Z: запоминаем ром, его данные и сохранения ДО удаления
    const linked = saves.filter((s) => s.romId === r.id);
    const blob = await getRomData(r.id);
    rememberDeleted({
      label: `ром «${r.name}»${linked.length ? ` и его сохранения (${linked.length})` : ''}`,
      restore: async () => {
        await idbPut('roms', r.id, { ...r });
        if (blob) await idbPut('blobs', `rom-${r.id}`, blob);
        for (const s of linked) await idbPut('saves', s.id, { ...s });
        await refresh();
      },
    });
    await Promise.all(linked.map((s) => idbDel('saves', s.id)));
    await idbDel('roms', r.id);
    await idbDel('blobs', `rom-${r.id}`);
    if (romId === r.id) { setRomId(null); setRunning(false); }
    await refresh();
    toast(`Ром «${r.name}» и его сохранения удалены`, 'err');
  };

  /* удалить папку ромов: ромы + их данные + сохранения (всё запоминается для Ctrl+Z);
     пустую папку просто убираем из списка — Ctrl+Z вернёт и её */
  const delRomFolder = async (folder: string) => {
    const inF = roms.filter((r) => r.folder === folder);
    if (!inF.length) {
      rememberDeleted({
        label: `пустую папку «${folder}»`,
        restore: async () => { addEmptyRomFolder(folder); await refresh(); },
      });
      removeEmptyRomFolder(folder);
      if (uploadFolder === folder) setUploadFolder('');
      sfx.fail();
      toast(`Пустая папка «${folder}» убрана`, 'err');
      return;
    }
    const items: { rom: RomDef; blob: ArrayBuffer | null; saves: SaveDef[] }[] = [];
    for (const r of inF) {
      items.push({ rom: r, blob: await getRomData(r.id), saves: saves.filter((s) => s.romId === r.id) });
    }
    rememberDeleted({
      label: `папку ромов «${folder}» (${inF.length})`,
      restore: async () => {
        for (const it of items) {
          await idbPut('roms', it.rom.id, { ...it.rom });
          if (it.blob) await idbPut('blobs', `rom-${it.rom.id}`, it.blob);
          for (const s of it.saves) await idbPut('saves', s.id, { ...s });
        }
        await refresh();
      },
    });
    for (const it of items) {
      await Promise.all(it.saves.map((s) => idbDel('saves', s.id)));
      await idbDel('roms', it.rom.id);
      await idbDel('blobs', `rom-${it.rom.id}`);
    }
    if (romId && inF.some((r) => r.id === romId)) { setRomId(null); setRunning(false); }
    removeEmptyRomFolder(folder);
    if (uploadFolder === folder) setUploadFolder('');
    await refresh();
    toast(`Папка «${folder}» удалена (ромов: ${inF.length})`, 'err');
  };

  const delSave = async (s: SaveDef) => {
    rememberDeleted({
      label: `сохранение «${s.name}» (слот ${s.slot})`,
      restore: async () => {
        await idbPut('saves', s.id, { ...s });
        await refresh();
      },
    });
    await idbDel('saves', s.id);
    await refresh();
    sfx.fail();
    toast(`Сохранение (слот ${s.slot}) удалено`, 'err');
  };

  /* строка рома в левой панели (в папке-спойлере или без папки) */
  const romRow = (r: RomDef) => (
    <div key={r.id} className={`border-2 px-3 py-2 transition-colors ${romId === r.id ? 'border-coral bg-coral/10' : 'border-edge bg-panel hover:border-edge2'}`}>
      <button className="w-full text-left cursor-pointer" onClick={() => { setRomId(r.id); setRunning(false); sfx.hover(); }}>
        <div className="flex items-center gap-2">
          <span className={`font-pixel text-[7px] px-1 py-0.5 ${r.ext === 'nes' ? 'bg-sky text-abyss' : 'bg-magma text-abyss'}`}>{r.ext.toUpperCase()}</span>
          <span className="font-display text-[12px] uppercase text-paper truncate">{r.name}</span>
        </div>
        <div className="tick-label text-faint mt-1">{fmtSize(r.size)} · сохранений: {saves.filter((s) => s.romId === r.id).length}</div>
      </button>
      <div className="flex items-center justify-between mt-1.5">
        <span className="tick-label text-faint truncate">{r.fileName}</span>
        <HoldDeleteButton
          onFire={() => void delRom(r)}
          label={`ром «${r.name}»`}
          ariaLabel="Удалить ром"
          title="Удалить ром"
          className="text-faint hover:text-coral cursor-pointer"
        >{Ic.trash(14)}</HoldDeleteButton>
      </div>
    </div>
  );

  const prefs = loadEmuPrefs();
  const pads = listGamepads();

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-2 flex-wrap">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-coral flex items-center gap-3">
            <span className="text-coral">{Ic.chip(22)}</span> Запуск эмулятора
          </h1>
          <PxBtn color="coral" className="ml-auto" onClick={() => fileRef.current?.click()}>{Ic.upload(15)} Загрузить ромы</PxBtn>
          <input ref={fileRef} type="file" accept=".nes,.md,.gen,.sms,.gg,.bin" multiple className="hidden" onChange={(e) => { void onUpload(e.target.files); e.target.value = ''; }} />
        </div>
        <p className="text-[13px] text-dim mb-6 max-w-3xl">
          Тестовый стенд: гоняйте ромы (NES и SEGA), проходите до нужного места и жмите <span className="text-gold font-display uppercase">«Сохранить состояние»</span> —
          слоты потом выбираются в редакторе заданий. Ромы раскладываются по папкам-спойлерам (как тайлы):
          создайте папку кнопкой «+ Папка», выберите её в списке и загрузите сразу пачку файлов.
          Удаление папок, ромов и сохранений подчиняется режиму из «Опций», а Ctrl+Z вернёт последнее удалённое.
        </p>

        <div className="grid lg:grid-cols-[300px_1fr] gap-5">
          <Panel title={`Ромы · ${roms.length}`} icon={Ic.cart(16)} accent="var(--color-coral)">
            <div className="p-2.5 space-y-1.5 max-h-[460px] overflow-y-auto">
              {/* папка для загрузки + создание новой */}
              <div className="flex items-center gap-1">
                <select
                  className="field-in flex-1 min-w-0 px-2 py-1.5 text-[11px] cursor-pointer"
                  value={uploadFolder}
                  onChange={(e) => setUploadFolder(e.target.value)}
                  title="Папка, в которую попадут загружаемые ромы"
                >
                  <option value="">Без папки</option>
                  {folderNames.map((f) => <option key={f} value={f}>📁 {f}</option>)}
                </select>
                <GhostBtn small className="shrink-0" onClick={() => { setNewFolderOpen((o) => !o); sfx.click(); }} title="Создать новую папку">{Ic.plus(11)} Папка</GhostBtn>
              </div>
              {newFolderOpen && (
                <div className="flex items-center gap-1">
                  <input
                    className="field-in flex-1 min-w-0 px-2 py-1.5 text-[11px]"
                    placeholder="Название новой папки"
                    maxLength={24}
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') createRomFolder(); if (e.key === 'Escape') setNewFolderOpen(false); }}
                  />
                  <PxBtn color="teal" small onClick={createRomFolder}>OK</PxBtn>
                </div>
              )}

              {/* папки-спойлеры с ромами */}
              {folderNames.map((f) => {
                const inF = romsIn(f);
                const collapsed = collapsedFolders[f] ?? false;
                return (
                  <div key={`f-${f}`}>
                    <div className="flex items-center gap-1 mb-1">
                      <button
                        onClick={() => setCollapsedFolders((s) => ({ ...s, [f]: !collapsed }))}
                        className="flex-1 min-w-0 flex items-center gap-1 text-left cursor-pointer hover:bg-[rgba(255,93,115,0.08)] px-1 py-0.5"
                        title={collapsed ? 'Развернуть' : 'Свернуть'}
                      >
                        <span className={`text-[10px] shrink-0 ${collapsed ? 'text-faint' : 'text-coral'}`}>{collapsed ? '▸' : '▾'}</span>
                        <span className="text-[10px] text-faint shrink-0">📁</span>
                        <span className="font-display text-[10px] uppercase text-dim truncate">{f}</span>
                        <span className="tick-label text-faint shrink-0">· {inF.length}</span>
                      </button>
                      <HoldDeleteButton
                        onFire={() => void delRomFolder(f)}
                        label={`папку ромов «${f}» (${inF.length})`}
                        ariaLabel="Удалить папку ромов"
                        title="Удалить папку вместе с ромами и их сохранениями"
                        className="text-faint hover:text-coral cursor-pointer shrink-0 px-0.5"
                      >{Ic.cross(10)}</HoldDeleteButton>
                    </div>
                    {!collapsed && <div className="space-y-1.5">{inF.map((r) => romRow(r))}</div>}
                  </div>
                );
              })}

              {/* ромы без папки */}
              {looseRoms.length > 0 && folderNames.length > 0 && (
                <div className="pt-1">
                  <div className="tick-label text-faint mb-1 px-1">Без папки · {looseRoms.length}</div>
                  <div className="space-y-1.5">{looseRoms.map((r) => romRow(r))}</div>
                </div>
              )}
              {looseRoms.length > 0 && folderNames.length === 0 && (
                <div className="space-y-1.5">{looseRoms.map((r) => romRow(r))}</div>
              )}

              {roms.length === 0 && (
                <div className="text-center py-8 px-3">
                  <span className="text-coral inline-block floaty">{Ic.cart(36)}</span>
                  <p className="text-[12px] text-dim mt-3">Загрузите файл .nes или .md/.sms — и вперёд</p>
                  <p className="text-[10px] text-faint mt-2 leading-tight">Создайте папку («+ Папка»), выберите её в списке — и жмите «Загрузить ромы»: можно сразу несколько файлов</p>
                </div>
              )}
            </div>
          </Panel>

          <div className="space-y-5">
            <Panel title={rom ? `${rom.name} · ${rom.ext === 'nes' ? 'NES' : 'SEGA'}` : 'Экран'} icon={Ic.play(16)} accent="var(--color-teal)">
              <div className="p-4">
                {!running || !romBuf ? (
                  <div className="aspect-[256/120] max-h-[220px] w-full bg-[#05070f] border-[3px] border-edge flex flex-col items-center justify-center gap-3 relative overflow-hidden">
                    <div className="absolute inset-0 starfield opacity-40" />
                    {rom ? (
                      <>
                        <span className="font-pixel text-[10px] text-dim relative z-10">PRESS START</span>
                        <PxBtn color="teal" onClick={() => void launch()}>{Ic.play(14)} Запустить</PxBtn>
                      </>
                    ) : (
                      <span className="font-pixel text-[9px] text-faint relative z-10">ВЫБЕРИТЕ ИЛИ ЗАГРУЗИТЕ РОМ</span>
                    )}
                  </div>
                ) : (
                  <div className="max-w-[640px] mx-auto">
                    <SegaBox
                      key={runKey}
                      romData={romBuf}
                      ext={isNes ? 'nes' : segExt(rom?.fileName ?? '')}
                      core={isNes ? 'nes' : undefined}
                      remapSpec={remapSpec}
                      initialState={(runState as string | null) ?? null}
                      onApi={(a: SegaApi) => { ejsApiRef.current = a; }}
                    />
                    <div className="flex gap-2 mt-3 flex-wrap">
                      <PxBtn color="gold" onClick={() => void createSave()}>{Ic.save(14)} Сохранить состояние</PxBtn>
                      <GhostBtn onClick={() => { setControlsOpen(true); sfx.click(); }}>{Ic.gear(13)} Управление</GhostBtn>
                      <GhostBtn onClick={() => resetEmu()}>{Ic.rotate(13)} Сброс (с начала)</GhostBtn>
                      <GhostBtn onClick={() => { setRunning(false); launchedRomRef.current = null; }}>{Ic.pause(13)} Выключить</GhostBtn>
                    </div>
                    {/* звук эмулятора — постоянная полоска под кнопкой «Управление» (вместо спрятанной панели EmulatorJS) */}
                    <div className="mt-2 max-w-[300px]">
                      <EmuVolumeChip />
                    </div>
                    <p className="text-[11px] text-dim mt-2 leading-relaxed">
                      Дойдите до нужного места и жмите «Сохранить состояние» — слот появится в списке ниже и будет доступен
                      в редакторе заданий. Раскладка клавиш и геймпад — кнопка «Управление». Громкость — ползунок «Звук эмулятора» и общие опции.
                    </p>
                  </div>
                )}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-dim">
                  {isNes || !rom ? (
                    <>
                      <div className="hud-chip pixel-corners px-2 py-1.5">{keyLabel(prefs.keys.UP)}{keyLabel(prefs.keys.DOWN)}{keyLabel(prefs.keys.LEFT)}{keyLabel(prefs.keys.RIGHT)} — крестовина</div>
                      <div className="hud-chip pixel-corners px-2 py-1.5">{keyLabel(prefs.keys.A)} — A · {keyLabel(prefs.keys.B)} — B</div>
                      <div className="hud-chip pixel-corners px-2 py-1.5">{keyLabel(prefs.keys.START)} — Start · {keyLabel(prefs.keys.SELECT)} — Select</div>
                      <div className="hud-chip pixel-corners px-2 py-1.5">Раскладка — в опциях</div>
                    </>
                  ) : (
                    <>
                      <div className="hud-chip pixel-corners px-2 py-1.5 sm:col-span-2">Клавиатура и джойстик — кнопка «Управление»</div>
                      <div className="hud-chip pixel-corners px-2 py-1.5 sm:col-span-2">Геймпад: крестовина/левый стик — движение</div>
                    </>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  {pads.map((g) => (
                    <span key={g.index} className="hud-chip pixel-corners px-2.5 py-1 text-[10px] text-teal flex items-center gap-1.5">
                      {Ic.dice(10)} {g.id.slice(0, 34)}{g.id.length > 34 ? '…' : ''}
                    </span>
                  ))}
                  {pads.length > 0 && isNes && <span className="tick-label text-faint">NES: геймпад 1 → игрок 1, геймпад 2 → игрок 2</span>}
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
                      <GhostBtn small onClick={() => loadSave(s)}>{Ic.play(11)}</GhostBtn>
                      <HoldDeleteButton
                        onFire={() => void delSave(s)}
                        label={`сохранение «${s.name}» (слот ${s.slot})`}
                        ariaLabel="Удалить сохранение"
                        title="Удалить сохранение"
                        className="text-faint hover:text-coral cursor-pointer"
                      >{Ic.trash(14)}</HoldDeleteButton>
                    </div>
                  ))}
                  {romSaves.length === 0 && <div className="text-[12px] text-dim sm:col-span-2 py-3 text-center">Сохранений нет — запустите ром и запишите первое состояние</div>}
                </div>
              </Panel>
            )}
          </div>
        </div>
      </div>

      {/* наш редактор управления (клавиатура + геймпад) */}
      {controlsOpen && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(4,6,14,0.88)]" onClick={() => setControlsOpen(false)} />
          <div className="relative pixel-panel pixel-corners pop-in w-full max-w-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-magma">{Ic.gear(18)}</span>
              <span className="font-display uppercase tracking-wider text-paper text-sm">
                Управление · {isNes ? 'NES' : 'SEGA Genesis'}
              </span>
              <span className="tick-label text-gold ml-2">применяется сразу</span>
              <GhostBtn small className="ml-auto" onClick={() => setControlsOpen(false)}>{Ic.cross(12)} Закрыть</GhostBtn>
            </div>
            <KeyBinder compact mode={isNes ? 'nes' : 'sega'} />
          </div>
        </div>
      )}
    </div>
  );
}

function segExt(fileName: string): string {
  return (fileName.split('.').pop() ?? 'md').toLowerCase();
}

