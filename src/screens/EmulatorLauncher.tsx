import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, getRomData } from '../store';
import { EmuVolumeChip, Field, GhostBtn, Ic, Panel, PxBtn } from '../ui';
import SegaBox, { type SegaApi } from '../SegaBox';
import KeyBinder from '../KeyBinder';
import { idbDel, idbGet, idbPut, uid, exportRomBase, importRomBase } from '../db';
import { CartridgeBadge, CartCutModal, CoverCropBtn, CoverPickBtn, CoverRemoveBtn, PlatName, RomPicsModal, RomTile, cartLabelOf, fileToCover, storeRomCover } from '../cartridge';
import type { RomDef, SaveDef, SaveKind } from '../types';
import { SAVE_KIND_CLS, SAVE_KIND_SHORT, saveKindOf, saveKindNum } from '../types';
import { HoldDeleteButton, rememberDeleted } from '../delGuard';
import {
  keyLabel, loadEmuPrefs, PREFS_EVENT, listGamepads,
  PAD_ACTIONS, NES_TO_RETRO, codeToEjsKey,
  SEGA_ACTIONS, SEGA_TO_RETRO,
  FAMILY_ACTIONS, FAMILY_KEYS_FIELD, FAMILY_KEY_KIND, FAMILY_RETRO,
  padFamilyOf, consoleLabel, consoleAspect,
  type PadFamily,
} from '../input';
import { sfx } from '../sound';

const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);

/* v0.62: короткое имя компонента единого выделения платформ (как GAME GEAR в v0.61) */
const P = PlatName;

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
  const dirRef = useRef<HTMLInputElement>(null); // v0.60: выбор ЦЕЛОЙ ПАПКИ ромов (webkitdirectory)
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
  /* v0.61: режим показа ромов в папке (по умолчанию СПИСОК) + размер плиток + развёрнутое окно картинок
     v0.62: cropJob — ром и картинка, из которой пользователь вырезает картридж ножницами ✂ */
  const [folderViews, setFolderViews] = useState<Record<string, 'list' | 'pics'>>({});
  const [picsTileSize, setPicsTileSize] = useState(64);
  const [expandFolder, setExpandFolder] = useState<string | null>(null);
  const [cropJob, setCropJob] = useState<{ rom: RomDef; file: File } | null>(null);

  /* ---------- полный экран эмулятора — как в задании в игре ----------
     Кнопка «Во весь экран» рядом с эмулятором разворачивает ТОЛЬКО экран игры,
     выход — Esc (или кнопка «Свернуть» до ухода в полный экран). */
  const [isFs, setIsFs] = useState(false);
  const fsWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fn = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', fn);
    return () => document.removeEventListener('fullscreenchange', fn);
  }, []);
  const toggleFs = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      fsWrapRef.current?.requestFullscreen().catch(() => toast('Браузер запретил полный экран', 'err'));
    }
  };

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
  // семейство раскладки текущего рома (NES/SEGA/SNES/GBA/PCE/Atari)
  const padFam: PadFamily = padFamilyOf(rom?.ext, rom?.fileName);
  // точное расширение для запуска (у legacy-SEGA добираем из имени файла)
  const realExt = rom ? (rom.ext === 'sega' ? segExt(rom.fileName) : rom.ext) : 'md';
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
    if (padFam === 'nes') {
      for (const a of PAD_ACTIONS) {
        const idx = NES_TO_RETRO[a];
        if (idx !== undefined && p.keys[a]) spec.push({ idx, key: codeToEjsKey(p.keys[a]) });
      }
    } else {
      const acts = FAMILY_ACTIONS[padFam];
      const keys = p[FAMILY_KEYS_FIELD[padFam]] as Record<string, string>;
      const isCode = FAMILY_KEY_KIND[padFam] === 'code';
      for (const a of acts) {
        const idx = FAMILY_RETRO[padFam][a];
        const k = keys[a] ?? '';
        if (idx !== undefined && k) spec.push({ idx, key: isCode ? codeToEjsKey(k) : k.toLowerCase() });
      }
    }
    return spec;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padFam, prefsTick, runKey]);

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

  /* загрузка СРАЗУ НЕСКОЛЬКИХ ромов в выбранную папку (select над кнопкой);
     v0.60: folderOverride — имя папки при загрузке ЦЕЛОЙ ПАПКИ кнопкой «Загрузить папку» */
  const onUpload = async (files: FileList | null, folderOverride?: string) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const folder = (folderOverride ?? uploadFolder).trim().slice(0, 24);
    let lastId: string | null = null;
    let loaded = 0, skipped = 0;
    for (const f of list) {
      const ext = (f.name.split('.').pop() ?? '').toLowerCase();
      const romExt = romFileExt(ext);
      if (!romExt) { skipped++; continue; }
      const buf = await f.arrayBuffer();
      const r: RomDef = {
        id: uid('rom'), name: f.name.replace(/\.[^.]+$/, ''), fileName: f.name,
        ext: romExt, size: f.size, createdAt: Date.now(),
        ...(folder ? { folder } : {}),
      };
      await idbPut('roms', r.id, r);
      await idbPut('blobs', `rom-${r.id}`, buf);
      lastId = r.id;
      loaded++;
    }
    if (!loaded) { toast('Нет поддерживаемых файлов: .nes · .md/.gen/.bin/.sms/.gg (SEGA) · .sfc/.smc (SNES) · .gb/.gbc (Game Boy) · .gba · .32x (SEGA 32X) · .a26 (Atari 2600) · .pce (PC Engine)', 'err'); return; }
    if (folder) removeEmptyRomFolder(folder); // папка больше не пустая
    await refresh();
    if (lastId) setRomId(lastId);
    setRunning(false);
    sfx.coin();
    toast(skipped ? `Ромов загружено: ${loaded} → папка «${folder || 'Без папки'}» · пропущено чужих: ${skipped}` : `Ромов загружено: ${loaded}${folder ? ` → папка «${folder}»` : ''}`, 'ok');
  };

  /* v0.60: «ЗАГРУЗИТЬ ПАПКУ» — скрытый input с webkitdirectory выбирает папку на диске;
     имя папки = первый сегмент webkitRelativePath (≤24 символов, fallback «Ромы»),
     папка сама встаёт на панель, спойлер называется как папка на диске */
  const onUploadFolder = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const raw = ((list[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '').split('/')[0].trim();
    const folder = (raw || 'Ромы').slice(0, 24);
    setUploadFolder(folder);
    await onUpload(files, folder);
  };

  /* v0.65: БАЗА РОМОВ — сохранить ВСЮ базу (ромы + обложки картриджей) одним файлом
     и загрузить её обратно: можно собрать базу на одном устройстве и залить на другое
     БЕЗ загрузки карт/тайлов/фишек (в Опциях «Экспорт библиотеки» возит вообще всё). */
  const baseRef = useRef<HTMLInputElement>(null);
  const doExportBase = async () => {
    try {
      const json = await exportRomBase();
      const n = (JSON.parse(json) as { roms?: unknown[] }).roms?.length ?? 0;
      if (!n) { toast('База ромов пуста — сначала загрузите ромы', 'err'); return; }
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `retropolia-rombase-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      sfx.coin();
      toast(`База ромов выгружена в файл (ромов: ${n}, с обложками)`, 'ok');
    } catch {
      toast('Не удалось выгрузить базу ромов', 'err');
    }
  };
  const doImportBase = async (file: File) => {
    try {
      const text = await file.text();
      const { added, skipped } = await importRomBase(text);
      await refresh();
      sfx.success();
      toast(added ? `База ромов загружена: новых ${added}, уже были ${skipped}` : 'Новых ромов нет — все уже были в базе', 'ok');
    } catch (e) {
      sfx.fail();
      toast(e instanceof Error ? e.message : 'Неверный файл базы ромов', 'err');
    }
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

  const createSave = async (kind: SaveKind) => {
    if (!rom) return;
    const st = (await ejsApiRef.current?.snapshot()) ?? null;
    if (!st) { toast('Эмулятор ещё не готов — дайте игре запуститься и попробуйте снова', 'err'); return; }
    const nextNum = (k: SaveKind) => {
      const nums = romSaves.filter((s) => saveKindOf(s) === k).map(saveKindNum);
      return nums.length ? Math.max(...nums) + 1 : 1;
    };
    const slot = romSaves.length ? Math.max(...romSaves.map((s) => s.slot)) + 1 : 1;
    /* «Моё задание» — единственное сохранение этого вида на ром: перезаписывается */
    if (kind === 'mytask') {
      const ex = romSaves.find((s) => saveKindOf(s) === 'mytask');
      const sv: SaveDef = ex
        ? { ...ex, state: st, createdAt: Date.now() }
        : { id: uid('save'), romId: rom.id, slot, name: 'Моё задание', kind: 'mytask', state: st, createdAt: Date.now() };
      await idbPut('saves', sv.id, sv);
      await refresh();
      sfx.success();
      toast(ex ? '«Моё задание» перезаписано (оно одно на игру)' : '«Моё задание» записано (одно на игру — при повторе перезапишется)', 'ok');
      return;
    }
    const name = kind === 'level' ? `Уровень ${nextNum('level')}` : kind === 'boss' ? `Босс ${nextNum('boss')}` : `Назови меня ${nextNum('private')}`;
    const sv: SaveDef = { id: uid('save'), romId: rom.id, slot, name, kind, state: st, createdAt: Date.now() };
    await idbPut('saves', sv.id, sv);
    await refresh();
    sfx.success();
    toast(`Сохранено: «${name}»${kind === 'private' ? ' — переименуйте его кнопкой ✏ в списке ниже' : ''}`, 'ok');
  };

  /* переименование ЧАСТНОГО сохранения («Назови меня N» → любое имя создателя) */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const doRename = async (s: SaveDef) => {
    const name = renameVal.trim().slice(0, 40);
    setRenamingId(null);
    if (!name || name === s.name) return;
    await idbPut('saves', s.id, { ...s, name });
    await refresh();
    sfx.coin();
    toast(`Сохранение переименовано: «${name}»`, 'ok');
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

  /* v0.61: обложка картриджа — загрузить/заменить/убрать (хранится вместе с ромом)
     v0.62: applyCover — общая запись для 📷 (готовая картинка) и ✂ (вырезание);
     обложка сохраняется КАК ЕСТЬ — размер и соотношение сторон не искажаются,
     показывается целиком (contain), без обрезки и сплющивания
     v0.63: «убрать обложку» — по тем же правилам, что удаление тайлов в редакторе
     карт: режим из Опций (у кнопки ✕) + запоминание для Ctrl+Z (вернёт обложку) */
  const applyCover = async (r: RomDef, cover: string) => {
    await storeRomCover(r, cover);
    await refresh();
    sfx.coin();
    toast(`Обложка картриджа обновлена: «${r.name}»`, 'ok');
  };
  const setCover = async (r: RomDef, file: File | null) => {
    if (!file) return;
    try {
      await applyCover(r, await fileToCover(file));
    } catch {
      toast('Не удалось прочитать картинку — попробуйте другой файл', 'err');
    }
  };
  const clearCover = async (r: RomDef) => {
    const old = r.cover;
    if (old) {
      rememberDeleted({
        label: `обложку картриджа «${r.name}»`,
        restore: async () => {
          const cur = await idbGet<RomDef>('roms', r.id);
          if (cur) { await idbPut('roms', r.id, { ...cur, cover: old }); await refresh(); }
        },
      });
    }
    await storeRomCover(r, null);
    await refresh();
    toast(`Обложка убрана: «${r.name}»`, 'ok');
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

  /* v0.62: «УДАЛИТЬ ВСЕ СОХРАНЕНИЯ» — одним махом стирает ВСЕ сохранения ТЕКУЩЕГО
     рома (кнопка в панели «Сохранения», где они загружаются); подчиняется режиму
     удаления из Опций (подтверждение/удержание), а Ctrl+Z возвращает ВСЕ слоты разом */
  const delAllSaves = async () => {
    if (!rom || !romSaves.length) return;
    const list = romSaves;
    rememberDeleted({
      label: `все сохранения рома «${rom.name}» (${list.length})`,
      restore: async () => {
        for (const s of list) await idbPut('saves', s.id, { ...s });
        await refresh();
      },
    });
    await Promise.all(list.map((s) => idbDel('saves', s.id)));
    await refresh();
    sfx.fail();
    toast(`Удалены все сохранения рома «${rom.name}» (${list.length})`, 'err');
  };

  /* строка рома в левой панели (в папке-спойлере или без папки);
     v0.61: вместо плоской надписи платформы — КАРТРИДЖ в форме и цвете своей
     платформы (или загруженная обложка) + кнопка 📷 загрузки обложки */
  const romRow = (r: RomDef) => (
    <div key={r.id} className={`border-2 px-3 py-2 transition-colors ${romId === r.id ? 'border-coral bg-coral/10' : 'border-edge bg-panel hover:border-edge2'}`}>
      <button className="w-full text-left cursor-pointer" onClick={() => { setRomId(r.id); setRunning(false); sfx.hover(); }}>
        <div className="flex items-center gap-2">
          <CartridgeBadge rom={r} h={20} />
          <span className="font-display text-[12px] uppercase text-paper truncate">{r.name}</span>
        </div>
        <div className="tick-label text-faint mt-1">{cartLabelOf(r)} · {fmtSize(r.size)} · сохранений: {saves.filter((s) => s.romId === r.id).length}</div>
      </button>
      <div className="flex items-center justify-between mt-1.5">
        <span className="tick-label text-faint truncate">{r.fileName}</span>
        <span className="flex items-center gap-2 shrink-0">
          <CoverPickBtn onPick={(file) => void setCover(r, file)} title={r.cover ? 'Заменить обложку картриджа' : 'Загрузить обложку картриджа (готовая картинка)'} className="text-[11px] leading-none text-faint" />
          <CoverCropBtn onPick={(file) => setCropJob({ rom: r, file })} title="✂ Вырезать картридж из картинки — вырезатель тайлов, как в редакторе карт" className="text-[11px] leading-none text-faint" />
          {r.cover && (
            <CoverRemoveBtn romName={r.name} onRemove={() => void clearCover(r)} className="text-[10px] leading-none text-faint hover:text-coral cursor-pointer" />
          )}
          <HoldDeleteButton
            onFire={() => void delRom(r)}
            label={`ром «${r.name}»`}
            ariaLabel="Удалить ром"
            title="Удалить ром"
            className="text-faint hover:text-coral cursor-pointer"
          >{Ic.trash(14)}</HoldDeleteButton>
        </span>
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
          <PxBtn color="coral" onClick={() => dirRef.current?.click()}>{Ic.folder(15)} Загрузить папку</PxBtn>
          {/* v0.65: база ромов одним файлом (ромы + обложки) — сохранить/загрузить */}
          <GhostBtn onClick={() => void doExportBase()} title="Сохранить ВСЮ базу ромов одним файлом (ромы + обложки картриджей)">{Ic.download(14)} Сохранить базу</GhostBtn>
          <GhostBtn onClick={() => baseRef.current?.click()} title="Загрузить базу ромов из файла (ромы + обложки; уже существующие не дублируются)">{Ic.upload(14)} Загрузить базу</GhostBtn>
          <input ref={baseRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImportBase(f); e.target.value = ''; }} />
          <input ref={fileRef} type="file" accept=".nes,.md,.gen,.bin,.sms,.gg,.sfc,.smc,.fig,.gb,.gbc,.gba,.32x,.a26,.pce" multiple className="hidden" onChange={(e) => { void onUpload(e.target.files); e.target.value = ''; }} />
          <input ref={dirRef} type="file" multiple className="hidden" {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)} onChange={(e) => { void onUploadFolder(e.target.files); e.target.value = ''; }} />
        </div>
        <p className="text-[13px] text-dim mb-6 max-w-3xl">
          Тестовый стенд: гоняйте ромы (<P>NES</P>, <P>SEGA Mega Drive</P> / <P>Master System</P> / <P>GAME GEAR</P>, <P>SNES</P>, <P>Game Boy/Color</P>, <P>GBA</P>, <P>SEGA 32X</P>, <P>Atari 2600</P>, <P>PC Engine</P>) — в том числе ромы .gg, они играют в родных пропорциях 160×144. Проходите до нужного места и записывайте состояние одной из ЧЕТЫРЁХ кнопок:
          <span className="text-gold font-display uppercase"> «Сохранить уровень»</span> (Уровень 1, 2, …),
          <span className="text-coral font-display uppercase"> «Сохранить босса»</span> (Босс 1, 2, …),
          <span className="text-teal font-display uppercase"> «Сохранить моё задание»</span> (одно на игру, перезаписывается) и
          <span className="text-sky font-display uppercase"> «Частное сохранение»</span> («Назови меня N» — переименовывается ✏).
          В игре после захвата ячейки выбираются уровни/боссы/моё задание; частные — только в редакторе заданий.
          Ромы раскладываются по папкам-спойлерам (как тайлы): создайте папку кнопкой «+ Папка», выберите её в списке и загрузите сразу пачку файлов.
          Каждому рому можно дать ОБЛОЖКУ КАРТРИДЖА: 📷 — готовая картинка (размер и пропорции читаются из файла), ✂ — вырезать картридж из картинки ТОЧНО ТАК ЖЕ, как тайлы в редакторе карт: фон АВТО/палитра/пипетка, допуск, мин. размер, склейка частей — клик по вырезанному тайлу ставит его обложкой (пропорции честные, прозрачный фон остаётся прозрачным). В режиме КАРТИНОК (кнопка 🖼 на папке) ромы показываются фотографиями реальных картриджей, а кнопка ⛶ разворачивает большой список картинок в отдельном окне.
          Удаление папок, ромов, сохранений и УБИРАНИЕ ОБЛОЖЕК (✕) подчиняются режиму из «Опций», а Ctrl+Z вернёт последнее удалённое.
          БАЗА РОМОВ: кнопка «Сохранить базу» выгружает ВСЕ ромы одним файлом — вместе с обложками картриджей; «Загрузить базу» заливает такой файл целиком (уже существующие ромы не дублируются) — можно собрать базу на одном устройстве и перенести на другое без загрузки всего остального.
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
                const pics = (folderViews[f] ?? 'list') === 'pics'; // v0.61: режим показа папки (дефолт — СПИСОК)
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
                      {/* v0.61: переключатель СПИСОК ↔ КАРТИНКИ + разворот картинок в отдельном окне */}
                      {inF.length > 0 && (
                        <>
                          <button
                            type="button"
                            onClick={() => { setFolderViews((s) => ({ ...s, [f]: pics ? 'list' : 'pics' })); sfx.click(); }}
                            title={pics ? 'Показать обычным списком' : 'Показать картинками картриджей/обложек'}
                            className="text-faint hover:text-gold cursor-pointer shrink-0 px-0.5"
                          >
                            {pics ? <span className="text-[11px] leading-none">☰</span> : Ic.grid(11)}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setExpandFolder(f); sfx.click(); }}
                            title="Развернуть список картинок этой папки в отдельном окне"
                            className="text-faint hover:text-gold cursor-pointer shrink-0 px-0.5"
                          >
                            <span className="text-[11px] leading-none">⛶</span>
                          </button>
                        </>
                      )}
                      <HoldDeleteButton
                        onFire={() => void delRomFolder(f)}
                        label={`папку ромов «${f}» (${inF.length})`}
                        ariaLabel="Удалить папку ромов"
                        title="Удалить папку вместе с ромами и их сохранениями"
                        className="text-faint hover:text-coral cursor-pointer shrink-0 px-0.5"
                      >{Ic.cross(10)}</HoldDeleteButton>
                    </div>
                    {!collapsed && (pics ? (
                      /* v0.61: КАРТИНКИ картриджей/обложек этой папки + слайдер размера плиток */
                      <div>
                        <div className="flex items-center gap-1.5 mb-1 px-0.5">
                          <span className="tick-label text-faint shrink-0">размер</span>
                          <input
                            type="range"
                            min={48}
                            max={140}
                            step={2}
                            value={picsTileSize}
                            onChange={(e) => setPicsTileSize(Number(e.target.value))}
                            className="flex-1 min-w-0 accent-[var(--color-coral)] cursor-pointer"
                            title="Больше — виднее, меньше — больше помещается"
                          />
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {inF.map((r) => (
                            <RomTile
                              key={r.id}
                              rom={r}
                              size={picsTileSize}
                              selected={romId === r.id}
                              onPick={() => { setRomId(r.id); setRunning(false); sfx.hover(); }}
                              onCover={(file) => void setCover(r, file)}
                              onCropFile={(file) => setCropJob({ rom: r, file })}
                              onRemoveCover={() => void clearCover(r)}
                            />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5">{inF.map((r) => romRow(r))}</div>
                    ))}
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
                  <p className="text-[12px] text-dim mt-3">Загрузите файл .nes, .md, .sms, .gg (GAME GEAR), .sfc, .gb, .gba, .pce — и вперёд</p>
                  <p className="text-[10px] text-faint mt-2 leading-tight">Создайте папку («+ Папка»), выберите её в списке — и жмите «Загрузить ромы»: можно сразу несколько файлов</p>
                </div>
              )}
            </div>
          </Panel>

          <div className="space-y-5">
            <Panel title={rom ? `${rom.name} · ${consoleLabel(rom.ext)}` : 'Экран'} icon={Ic.play(16)} accent="var(--color-teal)">
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
                    <div ref={fsWrapRef} className={`relative ${isFs ? 'bg-[#05070f] h-full w-full flex items-center justify-center p-4' : ''}`}>
                      <div style={isFs ? { width: `min(92vw, calc(88vh * ${consoleAspect(realExt).toFixed(4)}))` } : undefined}>
                        <SegaBox
                          key={runKey}
                          romData={romBuf}
                          ext={realExt}
                          core={isNes ? 'nes' : undefined}
                          remapSpec={remapSpec}
                          initialState={(runState as string | null) ?? null}
                          onApi={(a: SegaApi) => { ejsApiRef.current = a; }}
                        />
                      </div>
                      {isFs && (
                        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 tick-label text-faint opacity-70 pointer-events-none">ESC — выход из полного экрана</div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-3">
                      <PxBtn color="gold" onClick={() => void createSave('level')} title="Новое сохранение «Уровень N» — обычные точки заданий">{Ic.save(14)} Сохранить уровень</PxBtn>
                      <PxBtn color="coral" onClick={() => void createSave('boss')} title="Новое сохранение «Босс N» — схватки с боссами">{Ic.skull(14)} Сохранить босса</PxBtn>
                      <PxBtn color="teal" onClick={() => void createSave('mytask')} title="Одно сохранение «Моё задание» на игру — перезаписывается при повторном нажатии">{Ic.cart(14)} Сохранить моё задание</PxBtn>
                      <PxBtn color="sky" onClick={() => void createSave('private')} title="Сохранение «Назови меня N» — переименуйте его кнопкой ✏ в списке ниже; в игре НЕ выбирается">{Ic.pen(14)} Частное сохранение</PxBtn>
                    </div>
                    <div className="flex gap-2 mt-2 flex-wrap">
                      <GhostBtn onClick={() => { setControlsOpen(true); sfx.click(); }}>{Ic.gear(13)} Управление</GhostBtn>
                      <GhostBtn onClick={toggleFs} title="Развернуть экран игры на весь монитор (выход — Esc)">{isFs ? Ic.cross(12) : Ic.map(12)} {isFs ? 'Свернуть' : 'Во весь экран'}</GhostBtn>
                      <GhostBtn onClick={() => resetEmu()}>{Ic.rotate(13)} Сброс (с начала)</GhostBtn>
                      <GhostBtn onClick={() => { setRunning(false); launchedRomRef.current = null; }}>{Ic.pause(13)} Выключить</GhostBtn>
                    </div>
                    {/* звук эмулятора — постоянная полоска под кнопкой «Управление» (вместо спрятанной панели EmulatorJS) */}
                    <div className="mt-2 max-w-[300px]">
                      <EmuVolumeChip />
                    </div>
                    <p className="text-[11px] text-dim mt-2 leading-relaxed">
                      Дойдите до нужного места и запишите состояние: «Уровень N» и «Босс N» создаются по счёту, «Моё задание» одно на игру (перезаписывается),
                      частное («Назови меня N») можно переименовать кнопкой ✏ прямо в списке. Сохранения доступны в редакторе заданий;
                      уровни/боссы/моё задание выбираются и в игре — когда игрок захватывает ячейку и создаёт новое задание. Раскладка клавиш и геймпад — кнопка «Управление».
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
                <div className="p-3 space-y-2">
                  {/* v0.62: стереть ВСЕ сохранения этого рома одной кнопкой
                      (режим удаления из Опций: подтверждение/удержание; Ctrl+Z вернёт всё) */}
                  {romSaves.length > 0 && (
                    <div className="flex justify-end">
                      <HoldDeleteButton
                        onFire={() => void delAllSaves()}
                        label={`ВСЕ сохранения рома «${rom.name}» (${romSaves.length})`}
                        ariaLabel="Удалить все сохранения этого рома"
                        title="Удалить ВСЕ сохранения этого рома разом"
                        className="px-2.5 py-1 border-2 border-edge text-[10px] font-display uppercase text-dim hover:text-coral hover:border-coral/50 cursor-pointer"
                      >
                        <span className="inline-flex items-center gap-1.5">{Ic.trash(11)} Удалить все сохранения</span>
                      </HoldDeleteButton>
                    </div>
                  )}
                  <div className="grid sm:grid-cols-2 gap-2">
                  {romSaves.map((s) => {
                    const k = saveKindOf(s);
                    return (
                      <div key={s.id} className="border-2 border-edge bg-panel px-3 py-2.5 flex items-center gap-2">
                        <span className={`font-pixel text-[7px] px-1 py-0.5 shrink-0 ${SAVE_KIND_CLS[k]}`}>{SAVE_KIND_SHORT[k]}</span>
                        {renamingId === s.id ? (
                          <div className="flex-1 min-w-0 flex items-center gap-1">
                            <input
                              autoFocus
                              className="field-in w-full min-w-0 px-2 py-1 text-[12px]"
                              value={renameVal}
                              maxLength={40}
                              placeholder="Название сохранения"
                              onChange={(e) => setRenameVal(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') void doRename(s); if (e.key === 'Escape') setRenamingId(null); }}
                            />
                            <GhostBtn small onClick={() => void doRename(s)} title="Записать имя">{Ic.check(11)}</GhostBtn>
                          </div>
                        ) : (
                          <>
                            <div className="min-w-0 flex-1">
                              <div className="font-display text-[11px] uppercase text-paper truncate">{s.name}</div>
                              <div className="tick-label text-faint">S{s.slot} · {new Date(s.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                            </div>
                            <GhostBtn small onClick={() => loadSave(s)}>{Ic.play(11)}</GhostBtn>
                            {k === 'private' && (
                              <GhostBtn small onClick={() => { setRenamingId(s.id); setRenameVal(s.name); }} title="Переименовать частное сохранение">{Ic.pen(11)}</GhostBtn>
                            )}
                            <HoldDeleteButton
                              onFire={() => void delSave(s)}
                              label={`сохранение «${s.name}» (слот ${s.slot})`}
                              ariaLabel="Удалить сохранение"
                              title="Удалить сохранение"
                              className="text-faint hover:text-coral cursor-pointer"
                            >{Ic.trash(14)}</HoldDeleteButton>
                          </>
                        )}
                      </div>
                    );
                  })}
                  {romSaves.length === 0 && <div className="text-[12px] text-dim sm:col-span-2 py-3 text-center">Сохранений нет — запустите ром и запишите первое состояние</div>}
                  </div>
                </div>
              </Panel>
            )}
          </div>
        </div>
      </div>

      {/* v0.61: развёрнутый список картинок папки — отдельное окно со своим слайдером размера и прокруткой колёсиком */}
      {expandFolder && (
        <RomPicsModal
          title={expandFolder}
          roms={romsIn(expandFolder)}
          selectedId={romId}
          onClose={() => setExpandFolder(null)}
          onPick={(r) => { setRomId(r.id); setRunning(false); setExpandFolder(null); sfx.hover(); }}
          onCover={(r, file) => void setCover(r, file)}
          onCrop={(r, file) => setCropJob({ rom: r, file })}
          onRemoveCover={(r) => void clearCover(r)}
        />
      )}

      {/* v0.62→v0.63: НОЖНИЦЫ — окно вырезания картриджа из картинки ТОМ ЖЕ вырезателем,
          что режет тайлы в редакторе карт (из 📷-строк, плиток и окна картинок) */}
      {cropJob && (
        <CartCutModal
          rom={cropJob.rom}
          file={cropJob.file}
          onClose={() => setCropJob(null)}
          onSave={(url) => { void applyCover(cropJob.rom, url); setCropJob(null); }}
        />
      )}

      {/* наш редактор управления (клавиатура + геймпад) */}
      {controlsOpen && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-[rgba(4,6,14,0.88)]" onClick={() => setControlsOpen(false)} />
          <div className="relative pixel-panel pixel-corners pop-in w-full max-w-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-magma">{Ic.gear(18)}</span>
              <span className="font-display uppercase tracking-wider text-paper text-sm">
                Управление · {consoleLabel(realExt)}
              </span>
              <span className="tick-label text-gold ml-2">применяется сразу</span>
              <GhostBtn small className="ml-auto" onClick={() => setControlsOpen(false)}>{Ic.cross(12)} Закрыть</GhostBtn>
            </div>
            <KeyBinder compact mode={padFam} />
          </div>
        </div>
      )}
    </div>
  );
}

function segExt(fileName: string): string {
  return (fileName.split('.').pop() ?? 'md').toLowerCase();
}

/* Расширение файла рома → система для хранения (RomDef.ext).
   SEGA-файлы (md/gen/bin/sms/gg) по-прежнему храним как 'sega' — бейджи,
   фильтры лобби и старые ромы остаются совместимы; точное ядро добирается
   из fileName при запуске (segExt). Новые системы хранятся точно. */
function romFileExt(ext: string): string | null {
  switch (ext) {
    case 'nes': return 'nes';
    case 'md': case 'gen': case 'bin': case 'sms': case 'gg': return 'sega';
    case 'sfc': case 'smc': case 'fig': case 'snes': return 'snes';
    case 'gb': return 'gb';
    case 'gbc': return 'gbc';
    case 'gba': return 'gba';
    case '32x': return '32x';
    case 'a26': return 'a26';
    case 'pce': return 'pce';
    default: return null;
  }
}
