import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { Coin, Field, GhostBtn, Ic, Panel, PxBtn, Stepper } from '../ui';
import { cellAtPoint, drawBoard, fitView } from '../render';
import { idbGet, idbPut, uid } from '../db';
import { cartridgeArt, cardArt, fileToDataUrl } from '../assets';
import type { CardDef, CardEffect, CellType, ChaosKind, CodeOp, CodeType, EffectType, GameMap, MemCond, RomDef, SaveKind, TaskDef } from '../types';
import { CHAOS_LIST, chaosLabel, mkChaosCard, JOY_LIST, SAVE_KIND_CLS, SAVE_KIND_LABEL, SAVE_KIND_SHORT, saveKindOf } from '../types';
import { CODE_TYPE_LABEL, OP_LABEL, formatCond, hex8, memCondText, parseCond, parseHex } from '../memcode';
import { renumberByPath, fixLinksAfterDelete } from '../render';
import { HoldDeleteButton, rememberDeleted } from '../delGuard';
import { effSpoilerOpen, loadSpoilerFlag, loadSpoilerRec, saveSpoilerFlag, saveSpoilerRec } from '../spoilers';
import { CartridgeBadge, CartCutModal, CoverCropBtn, CoverPickBtn, CoverRemoveBtn, PlatName, RomPicsModal, RomTile, cartLabelOf, fileToCover, storeRomCover } from '../cartridge';
import { sfx } from '../sound';

const EFFECTS: { key: EffectType; label: string; hasValue?: boolean; hasTarget?: boolean; unit?: string; def: number }[] = [
  { key: 'move', label: 'Сдвиг по маршруту на N ячеек', hasValue: true, unit: 'яч. (− назад)', def: 3 },
  { key: 'teleport', label: 'Переход на ячейку под номером N', hasValue: true, unit: '№ ячейки', def: 1 },
  { key: 'jail', label: 'Отпуск: пропуск N ходов', hasValue: true, unit: 'ходов', def: 1 },
  { key: 'wrongway', label: 'Поворот не туда: прыжок к спец-ячейке', def: 0 },
  { key: 'extraTurn', label: 'Дополнительный ход текущего игрока', def: 0 },
  { key: 'skipTurn', label: 'Пропуск хода текущего игрока', def: 0 },
  { key: 'playerExtra', label: 'Доп. ход игроку под номером N', hasTarget: true, def: 0 },
  { key: 'playerSkip', label: 'Пропуск хода игроку под номером N', hasTarget: true, def: 0 },
  { key: 'addMin', label: 'Плюс N минут времени', hasValue: true, unit: 'мин', def: 5 },
  { key: 'subMin', label: 'Минус N минут времени', hasValue: true, unit: 'мин', def: 5 },
  { key: 'addTries', label: 'Плюс N попыток', hasValue: true, unit: 'поп.', def: 5 },
  { key: 'subTries', label: 'Минус N попыток', hasValue: true, unit: 'поп.', def: 5 },
  { key: 'toInventory', label: 'В инвентарь: игрок забирает карточку себе (применит или продаст позже)', def: 0 },
  { key: 'diePlus', label: 'Радость: +1 кубик — следующий бросок сразу тремя', def: 0 },
  { key: 'addMinTries', label: 'Радость: плюс N минут И N попыток', hasValue: true, unit: 'ед.', def: 5 },
  { key: 'freeSkip', label: 'Радость: джокер — пропуск любого задания без платы', def: 0 },
  { key: 'immuneSega', label: 'Радость: иммунитет к SEGA-заданию (в инвентарь)', def: 0 },
  { key: 'immuneNes', label: 'Радость: иммунитет к NES-заданию (в инвентарь)', def: 0 },
];

/* Перемещения (сдвиг на N, телепорт на №N, «поворот не туда») убраны из ЛОВУШЕК —
   вместо них рисуются стрелки «ПЕРЕХОД» в редакторе карт. Карточки со старыми
   эффектами из прежних сохранений работают по-прежнему. */
const TRAP_NO_EFFECTS: EffectType[] = ['move', 'teleport', 'wrongway'];
const effListFor = (cellType: CellType | undefined) =>
  cellType === 'trap' ? EFFECTS.filter((ef) => !TRAP_NO_EFFECTS.includes(ef.key)) : EFFECTS;
const effResolve = (cellType: CellType | undefined, cur: EffectType): EffectType =>
  effListFor(cellType).some((ef) => ef.key === cur) ? cur : 'jail';

export const effectLabel = (e: CardEffect): string => {
  const meta = EFFECTS.find((x) => x.key === e.type);
  if (!meta) return e.type;
  let s = meta.label.replace('N', String(e.value));
  if (meta.hasTarget) s += ` (игрок №${e.target})`;
  return s;
};

export default function TaskEditor() {
  const { maps, roms, saves, setScreen, refresh, toast } = useApp();
  const spoilerMode = useApp((st) => st.options.spoilerMode); // v0.70: режим спойлеров (запоминать / всегда свёрнуты / развёрнуты)
  const [map, setMap] = useState<GameMap | null>(null);
  const [selCell, setSelCell] = useState<number | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  // точка нажатия: чтобы отличить клик (выбор ячейки) от перетаскивания камеры
  const inspectDownRef = useRef<{ x: number; y: number } | null>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const mapRef = useRef(map); mapRef.current = map;
  const selRef = useRef(selCell); selRef.current = selCell;

  // форма задания
  const [fRom, setFRom] = useState('');
  const [fSave, setFSave] = useState('');
  const [fTitle, setFTitle] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fImg, setFImg] = useState('');
  const [fChaos, setFChaos] = useState('');
  const [fJoy, setFJoy] = useState('');
  /* v0.55: КАСТОМНАЯ ЦЕНА задания — пустая строка = «стандарт карты» */
  const [fWinCoins, setFWinCoins] = useState('');
  const [fLoseCoins, setFLoseCoins] = useState('');
  const [fWinHp, setFWinHp] = useState('');
  const [fLoseHp, setFLoseHp] = useState('');
  // форма карточки
  const [cName, setCName] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cType, setCType] = useState<EffectType>('move');
  const [cValue, setCValue] = useState(3);
  const [cTarget, setCTarget] = useState(1);
  const [cImg, setCImg] = useState('');
  // оформление ячейки (цвет / название / картинка)
  const [vLabel, setVLabel] = useState('');
  const [vColor, setVColor] = useState('');
  const [vImg, setVImg] = useState('');
  /* v0.68 ЗАЧЁТ ПО КОДУ: условие по памяти эмулятора (код из CodeSearch) */
  const [fCond, setFCond] = useState<MemCond | null>(null);
  const [codeIn, setCodeIn] = useState('');
  const [codeErr, setCodeErr] = useState('');
  /* v0.68 ПОРАЖЕНИЕ ПО КОДУ: условие провала задания (код из CodeSearch) */
  const [fCondFail, setFCondFail] = useState<MemCond | null>(null);
  const [codeFailIn, setCodeFailIn] = useState('');
  const [codeFailErr, setCodeFailErr] = useState('');
  /* v0.70 ТОЛЬКО ПО КОДУ: ручные кнопки для этого задания отключены — всё решают коды */
  const [fCodeOnly, setFCodeOnly] = useState(false);
  /* v0.71: ОДИНАКОВЫЕ УСЛОВИЯ на победу и поражение — противоречие: одно и то же состояние
     памяти не может быть одновременно зачётом и провалом (поражение проверяется первым —
     зачёт по коду тогда недостижим вообще). Предупреждаем и запрещаем сохранение. */
  const codeConflict = !!fCond && !!fCondFail
    && fCond.a === fCondFail.a && fCond.t === fCondFail.t && fCond.op === fCondFail.op && fCond.v === fCondFail.v;

  const tiles = useApp((st) => st.tiles);
  const tileById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);

  const openMap = (m: GameMap) => {
    setMap(JSON.parse(JSON.stringify(m)) as GameMap);
    setSelCell(null);
    requestAnimationFrame(() => {
      const cv = canvasRef.current;
      if (cv) setView(fitView(m, cv.clientWidth, cv.clientHeight));
    });
    sfx.coin();
  };

  useEffect(() => {
    const cell = map && selCell !== null ? map.cells[selCell] : null;
    if (!cell) return;
    setFRom(cell.task?.romId ?? '');
    setFSave(cell.task?.saveId ?? '');
    setFTitle(cell.task?.title ?? '');
    setFDesc(cell.task?.desc ?? '');
    setFImg(cell.task?.imageId ?? '');
    setFChaos(cell.task?.chaos ?? '');
    setFJoy(cell.task?.joy ?? '');
    setFWinCoins(cell.task?.winCoins !== undefined ? String(cell.task.winCoins) : '');
    setFLoseCoins(cell.task?.loseCoins !== undefined ? String(cell.task.loseCoins) : '');
    setFWinHp(cell.task?.winHp !== undefined ? String(cell.task.winHp) : '');
    setFLoseHp(cell.task?.loseHp !== undefined ? String(cell.task.loseHp) : '');
    setVLabel(cell.label ?? '');
    setVColor(cell.color ?? '');
    setVImg(cell.imageId ?? '');
    setFCond(cell.task?.code ?? null);
    setCodeIn(cell.task?.code ? formatCond(cell.task.code) : '');
    setCodeErr('');
    setFCondFail(cell.task?.codeFail ?? null);
    setCodeFailIn(cell.task?.codeFail ? formatCond(cell.task.codeFail) : '');
    setCodeFailErr('');
    setFCodeOnly(cell.task?.codeOnly ?? false);
  }, [selCell, map?.id]);

  const CELL_COLORS = ['#ffcf3f', '#ff5d73', '#5aa9ff', '#2ee6a8', '#ff8b3f', '#9be84d', '#c07aff', '#e9ecff'];

  const saveVisuals = async () => {
    if (!map || selCell === null) return;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.cells[selCell].label = vLabel.trim() || undefined;
    nextMap.cells[selCell].color = vColor || undefined;
    nextMap.cells[selCell].imageId = vImg || undefined;
    setMap(nextMap);
    await persist(nextMap);
    sfx.coin();
    toast(`Оформление ячейки №${selCell + 1} сохранено`, 'ok');
  };

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      const cv = canvasRef.current;
      const m = mapRef.current;
      if (cv && m) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.floor(w * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr); }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawBoard(ctx, m, {
          view: viewRef.current, width: w, height: h, tileById,
          captured: {}, colorById: {}, currentCell: selRef.current,
          showNumbers: true, tokens: [], time: t, hoverCell: null,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tileById]);

  const persist = async (m: GameMap) => {
    m.updatedAt = Date.now();
    await idbPut('maps', m.id, m);
    await refresh();
  };

  const mutate = (fn: (m: GameMap) => void, silent = true) => {
    setMap((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as GameMap;
      fn(next);
      return next;
    });
    if (!silent) sfx.click();
  };

  const pickCell = (e: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    const v = viewRef.current;
    const wx = v.x + (e.clientX - r.left - r.width / 2) / v.zoom;
    const wy = v.y + (e.clientY - r.top - r.height / 2) / v.zoom;
    const m = mapRef.current;
    if (!m) return;
    // БАГ-ФИКС: раньше искали по старой сетке (c.x/c.y по 64px), а ячейки нового
    // редактора — свободные (cx/cy/cw/ch в пикселях) и не находились вообще.
    // Теперь cellAtPoint понимает ОБА формата.
    const idx = cellAtPoint(m, wx, wy);
    setSelCell(idx >= 0 ? idx : null);
    if (idx >= 0) sfx.hover();
  };

  const romSaves = saves.filter((s) => s.romId === fRom);
  const cell = map && selCell !== null ? map.cells[selCell] : null;
  const romName = (id: string) => roms.find((r) => r.id === id)?.name ?? '—';

  /* ---------- ЛЕВАЯ ПАНЕЛЬ РОМОВ (как в «Запуске эмулятора») ----------
   Показывается, когда редактируется ячейка-задание: папки-спойлеры,
   клик по рому выбирает его для задания. Никаких списков на сотни строк. */
  const [romFoldersOpenRaw, setRomFoldersOpenRaw] = useState<Record<string, boolean>>(() => loadSpoilerRec('taskFolders')); // v0.70: состояние в localStorage, старт по режиму спойлеров
  const [romSavesOpenRaw, setRomSavesOpenRaw] = useState<boolean>(() => loadSpoilerFlag('taskSaves') ?? true); // v0.70: спойлер сохранений — тоже запоминается
  // v0.61: режим показа ромов в папке (дефолт СПИСОК) + размер плиток + развёрнутое окно картинок + обложки
  const [romFolderViews, setRomFolderViews] = useState<Record<string, 'list' | 'pics'>>({});
  const [romPicsTileSize, setRomPicsTileSize] = useState(56);
  const [expandRomFolder, setExpandRomFolder] = useState<string | null>(null);
  /* v0.62: cropJob — ром и картинка, из которой вырезается картридж ножницами ✂ */
  const [romCropJob, setRomCropJob] = useState<{ rom: RomDef; file: File } | null>(null);
  /* v0.70: стартовая ОТКРЫТОСТЬ папок и спойлера сохранений — по режиму спойлеров из Опций;
     в режиме «запоминать» каждое переключение пишется в localStorage (переживает перезаход).
     v0.71: режим работает только при ВХОДЕ в редактор — дальше папки/сохранения свободно
     сворачиваются и разворачиваются руками: ручные переключения (folderOvr/savesOvr)
     показываются поверх стартового режима, а в «запоминать» ещё и сохраняются. */
  const [romFolderOvr, setRomFolderOvr] = useState<Record<string, boolean>>({}); // v0.71: ручные переключения папок
  const [romSavesOvr, setRomSavesOvr] = useState<boolean | null>(null); // v0.71: ручное переключение спойлера сохранений
  const romFolderOpen = (f: string) => romFolderOvr[f] ?? effSpoilerOpen(spoilerMode, romFoldersOpenRaw[f], false);
  const toggleRomFolder = (f: string, open: boolean) => {
    setRomFolderOvr((s) => ({ ...s, [f]: open }));
    setRomFoldersOpenRaw((s) => { const next = { ...s, [f]: open }; if (spoilerMode === 'remember') saveSpoilerRec('taskFolders', next); return next; });
  };
  const romSavesOpen = romSavesOvr ?? effSpoilerOpen(spoilerMode, romSavesOpenRaw, true);
  const toggleRomSaves = () => {
    const next = !romSavesOpen;
    setRomSavesOvr(next);
    setRomSavesOpenRaw(next);
    if (spoilerMode === 'remember') saveSpoilerFlag('taskSaves', next);
  };
  /* v0.62: applyRomCover — общая запись для 📷 (готовая картинка) и ✂ (вырезание):
     обложка сохраняется КАК ЕСТЬ — пропорции честные, показывается целиком
     v0.63: «убрать обложку» — по тем же правилам, что удаление тайлов в редакторе
     карт: режим из Опций (у кнопки ✕) + запоминание для Ctrl+Z (вернёт обложку) */
  const applyRomCover = async (r: RomDef, cover: string) => {
    await storeRomCover(r, cover);
    await refresh();
    sfx.coin();
    toast(`Обложка картриджа обновлена: «${r.name}»`, 'ok');
  };
  const setRomCoverFor = async (r: RomDef, file: File | null) => {
    if (!file) return;
    try {
      await applyRomCover(r, await fileToCover(file));
    } catch {
      toast('Не удалось прочитать картинку — попробуйте другой файл', 'err');
    }
  };
  const clearRomCoverFor = async (r: RomDef) => {
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
  const romFolders = useMemo(() => [...new Set(roms.map((r) => r.folder ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [roms]);
  const looseRoms = useMemo(() => roms.filter((r) => !r.folder), [roms]);
  const romsIn = (folder: string) => roms.filter((r) => r.folder === folder);
  const pickRom = (r: { id: string }) => {
    setFRom(r.id);
    setFSave('');
    sfx.hover();
  };
  const romPanelRow = (r: RomDef) => {
    const sel = fRom === r.id;
    const svCount = saves.filter((s) => s.romId === r.id).length;
    return (
      <div key={r.id}>
        <div className={`relative border-2 px-2.5 py-2 transition-colors ${sel ? 'border-gold bg-gold/10' : 'border-edge bg-panel hover:border-edge2'}`}>
        <button
          onClick={() => pickRom(r)}
          title={`${r.name} — клик: выбрать ром для задания`}
          className="w-full text-left cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <CartridgeBadge rom={r} h={18} />
            <span className={`font-display text-[11px] uppercase truncate ${sel ? 'text-gold' : 'text-paper'}`}>{sel ? '✓ ' : ''}{r.name}</span>
          </div>
          <div className="tick-label text-faint mt-1">{cartLabelOf(r)} · сохранений: {svCount}</div>
        </button>
        {/* v0.61: 📷 обложка картриджа прямо в строке рома; v0.63: ✂ — вырезатель тайлов как в редакторе карт,
            ✕ убрать обложку — по правилам удаления из Опций */}
        <div className="absolute top-1 right-1 flex items-center gap-1 bg-[rgba(4,6,14,0.72)] px-1 rounded-sm">
          <CoverPickBtn onPick={(file) => void setRomCoverFor(r, file)} title={r.cover ? 'Заменить обложку картриджа' : 'Загрузить обложку картриджа (готовая картинка)'} className="text-[10px] leading-none py-0.5 text-faint" />
          <CoverCropBtn onPick={(file) => setRomCropJob({ rom: r, file })} title="✂ Вырезать картридж из картинки — вырезатель тайлов, как в редакторе карт" className="text-[10px] leading-none py-0.5 text-faint" />
          {r.cover && (
            <CoverRemoveBtn romName={r.name} onRemove={() => void clearRomCoverFor(r)} className="text-[9px] leading-none py-0.5 text-faint hover:text-coral cursor-pointer" />
          )}
        </div>
        </div>
        {/* СПОЙЛЕР СОХРАНЕНИЙ под выбранным ромом — как в редакторе сохранений:
            цветные метки видов (уровень/босс/моё задание/частное), клик выбирает сохранение */}
        {sel && svCount > 0 && (
          <div className="mt-1 border-2 border-edge bg-[rgba(11,14,28,0.6)] px-2 py-1.5">
            <button
              onClick={toggleRomSaves}
              className="w-full flex items-center gap-1 text-left cursor-pointer hover:bg-[rgba(255,207,63,0.08)] px-0.5 py-0.5"
              title={romSavesOpen ? 'Свернуть' : 'Развернуть'}
            >
              <span className={`text-[10px] shrink-0 ${romSavesOpen ? 'text-gold' : 'text-faint'}`}>{romSavesOpen ? '▾' : '▸'}</span>
              <span className="tick-label text-dim">💾 Сохранения · {svCount}</span>
              <span className="tick-label text-faint ml-auto">клик — выбрать</span>
            </button>
            {romSavesOpen && (
              <div className="space-y-1 mt-1">
                {saves.filter((sv) => sv.romId === r.id).map((sv) => {
                  const k = saveKindOf(sv);
                  const picked = fSave === sv.id;
                  return (
                    <button
                      key={sv.id}
                      onClick={() => { setFSave(sv.id); sfx.hover(); }}
                      title={`Выбрать «${sv.name}» для этого задания`}
                      className={`w-full text-left border-2 px-2 py-1.5 cursor-pointer transition-colors ${picked ? 'border-gold bg-gold/10' : 'border-edge bg-panel hover:border-edge2'}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`font-pixel text-[7px] px-1 py-0.5 shrink-0 ${SAVE_KIND_CLS[k]}`}>{SAVE_KIND_SHORT[k]}</span>
                        <span className={`font-display text-[10px] uppercase truncate ${picked ? 'text-gold' : 'text-paper'}`}>{picked ? '✓ ' : ''}{sv.name}</span>
                      </div>
                      <div className="tick-label text-faint mt-0.5">S{sv.slot} · {new Date(sv.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const saveTask = async () => {
    if (!map || selCell === null) return;
    const romIsNes = roms.find((r) => r.id === fRom)?.ext === 'nes';
    if (!fRom || (romIsNes && !fSave)) {
      sfx.fail();
      toast(romIsNes ? 'Выберите ром и сохранение' : 'Выберите ром', 'err');
      return;
    }
    /* v0.71: одинаковое условие на победу и поражение — противоречие, сохранять нельзя */
    if (codeConflict) {
      sfx.fail();
      toast('Зачёт и поражение — ОДНО И ТО ЖЕ условие: измените или уберите одно из них', 'err');
      return;
    }
    let imageId: string | undefined = fImg || undefined;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    const task: TaskDef = {
      romId: fRom, saveId: fSave || undefined,
      title: fTitle.trim() || romName(fRom),
      desc: fDesc.trim() || 'Пройдите фрагмент игры, как договорились игроки.',
      imageId,
      chaos: (fChaos || undefined) as TaskDef['chaos'],
      joy: (fJoy || undefined) as TaskDef['joy'],
      /* v0.55: кастомные награда/проигрыш; не заданы — стандарт карты */
      winCoins: fWinCoins !== '' ? Math.max(0, Math.floor(Number(fWinCoins) || 0)) : undefined,
      loseCoins: fLoseCoins !== '' ? Math.max(0, Math.floor(Number(fLoseCoins) || 0)) : undefined,
      winHp: fWinHp !== '' ? Math.max(0, Math.floor(Number(fWinHp) || 0)) : undefined,
      loseHp: fLoseHp !== '' ? Math.max(0, Math.floor(Number(fLoseHp) || 0)) : undefined,
      /* v0.68: зачёт по коду — условие по памяти эмулятора (CodeSearch) */
      ...(fCond ? { code: fCond } : {}),
      /* v0.68: поражение по коду — условие провала задания (CodeSearch) */
      ...(fCondFail ? { codeFail: fCondFail } : {}),
      /* v0.70: только по коду — ручные кнопки и голосование для ячейки отключены */
      ...(fCodeOnly ? { codeOnly: true } : {}),
    };
    nextMap.cells[selCell].task = task;
    setMap(nextMap);
    await persist(nextMap);
    sfx.success();
    toast(`Задание ячейки №${selCell + 1} сохранено`, 'ok');
  };

  const addCard = async () => {
    if (!map || selCell === null) return;
    const cellType = map.cells[selCell].type;
    const kind = cellType === 'trap' ? 'trap' : 'bonus';
    const effT = effResolve(cellType, cType); // у ловушек убранные эффекты подменяются на «Отпуск»
    if (!cName.trim()) { sfx.fail(); toast('Назовите карточку', 'err'); return; }
    let imageId: string | undefined = cImg || undefined;
    const card: CardDef = {
      id: uid('card'), kind, name: cName.trim(),
      desc: cDesc.trim() || effectLabel({ type: effT, value: cValue, target: cTarget }),
      imageId, effect: { type: effT, value: cValue, target: cTarget },
    };
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    (kind === 'bonus' ? nextMap.bonusCards : nextMap.trapCards).push(card);
    setMap(nextMap);
    await persist(nextMap);
    setCName(''); setCDesc(''); setCImg('');
    sfx.card();
    toast(`Карточка «${card.name}» добавлена в колоду`, 'ok');
  };

  const toggleChaosCard = async (k: ChaosKind) => {
    if (!map) return;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    const has = nextMap.bonusCards.some((c) => c.chaos === k);
    if (has) nextMap.bonusCards = nextMap.bonusCards.filter((c) => c.chaos !== k);
    else nextMap.bonusCards.push(mkChaosCard(k));
    setMap(nextMap);
    await persist(nextMap);
    sfx.click();
  };

  const delCard = async (id: string) => {
    if (!map) return;
    const inBonus = map.bonusCards.find((c) => c.id === id);
    const inTrap = map.trapCards.find((c) => c.id === id);
    const card = inBonus ?? inTrap;
    if (card && map.id) {
      const mapId = map.id;
      const deckKind = inBonus ? 'bonus' : 'trap';
      const snap = JSON.parse(JSON.stringify(card));
      rememberDeleted({
        label: `карточку «${card.name}»`,
        restore: async () => {
          const cur = await idbGet<GameMap>('maps', mapId);
          if (!cur) return;
          const next = JSON.parse(JSON.stringify(cur)) as GameMap;
          const deck = deckKind === 'bonus' ? next.bonusCards : next.trapCards;
          if (!deck.some((c) => c.id === (snap as { id: string }).id)) deck.push(snap);
          next.updatedAt = Date.now();
          await idbPut('maps', mapId, next);
          setMap(next); // если редактор закрыт — setMap безвреден, данные восстановятся в IDB
          await useApp.getState().refresh();
        },
      });
    }
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.bonusCards = nextMap.bonusCards.filter((c) => c.id !== id);
    nextMap.trapCards = nextMap.trapCards.filter((c) => c.id !== id);
    setMap(nextMap);
    await persist(nextMap);
    toast('Карточка удалена', 'err');
  };

  const setCellType = async (type: CellType) => {
    if (!map || selCell === null) return;
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.cells[selCell].type = type;
    setMap(nextMap);
    await persist(nextMap);
  };

  const delCell = async () => {
    if (!map || selCell === null) return;
    const cellSnap = JSON.parse(JSON.stringify(map.cells[selCell]));
    const cellIdx = selCell;
    const mapId = map.id;
    rememberDeleted({
      label: `ячейку маршрута`,
      restore: async () => {
        const cur = await idbGet<GameMap>('maps', mapId);
        if (!cur) return;
        const next = JSON.parse(JSON.stringify(cur)) as GameMap;
        next.cells.splice(Math.min(cellIdx, next.cells.length), 0, cellSnap);
        renumberByPath(next); // номера — по маршруту
        next.updatedAt = Date.now();
        await idbPut('maps', mapId, next);
        setMap(next);
        await useApp.getState().refresh();
      },
    });
    const nextMap = JSON.parse(JSON.stringify(map)) as GameMap;
    nextMap.cells.splice(selCell, 1);
    fixLinksAfterDelete(nextMap, selCell); // сдвигаем стрелки и перенумеровываем по маршруту
    setMap(nextMap);
    setSelCell(null);
    await persist(nextMap);
    toast('Ячейка удалена, маршрут перенумерован', 'err');
  };

  const onImg = (setter: (v: string) => void) => async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !f.type.startsWith('image/')) return;
    setter(await fileToDataUrl(f));
    sfx.coin();
  };

  const issues: string[] = [];
  const warns: string[] = [];
  if (map) {
    const bonusCells = map.cells.filter((c) => c.type === 'bonus').length;
    const trapCells = map.cells.filter((c) => c.type === 'trap').length;
    const quizCells = map.cells.filter((c) => c.type === 'quiz').length;
    const noTask = map.cells.filter((c) => c.type === 'task' && !c.task).length;
    if (map.cells.length < 10) issues.push(`Минимум 10 ячеек (сейчас ${map.cells.length})`);
    if (bonusCells > 0 && map.bonusCards.length === 0) issues.push('Есть ячейки-бонусы, но колода бонусов пуста — создайте карточку или уберите ячейки');
    if (trapCells > 0 && map.trapCards.length === 0) issues.push('Есть ячейки-ловушки, но колода ловушек пуста — создайте карточку или уберите ячейки');
    if (quizCells > 0 && (map.quizzes ?? []).length === 0) issues.push('Есть ячейки-квизы, но на карте нет вопросов — создайте квизы в редакторе или уберите ячейки');
    if (noTask > 0) warns.push(`${noTask} ячеек без заданий будут «передышкой» в игре`);
  }

  const completeMap = async () => {
    if (!map) return;
    if (issues.length) { sfx.fail(); toast(issues[0], 'err'); return; }
    const nextMap = { ...map, ready: true };
    setMap(nextMap);
    await persist(nextMap);
    sfx.success();
    toast(`Карта «${map.name}» готова к игре!`, 'ok');
    setScreen('menu');
  };

  if (!map) {
    return (
      <div className="h-full crt-grid-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="flex items-center gap-4 mb-6">
            <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
            <h1 className="font-display text-2xl uppercase tracking-wider text-magma flex items-center gap-3">
              <span className="text-magma">{Ic.cart(22)}</span> Редактор заданий
            </h1>
          </div>
          <p className="text-[13px] text-dim mb-5 max-w-2xl">
            Выберите карту: затем кликайте по ячейкам, привязывайте ром + сохранение, картинку и описание задания.
            Для ячеек-бонусов и ловушек собираются колоды карточек с эффектами.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {maps.map((m) => {
              const noTask = m.cells.filter((c) => c.type === 'task' && !c.task).length;
              return (
                <button key={m.id} onClick={() => openMap(m)} className="text-left pixel-panel pixel-corners p-4 transition-transform hover:-translate-y-1 hover:border-edge2 cursor-pointer group">
                  <div className="flex items-center justify-between">
                    <span className="font-display uppercase text-paper group-hover:text-gold transition-colors">{m.name}</span>
                    {m.ready ? <span className="tick-label text-teal">Готова</span> : <span className="tick-label text-gold">В работе</span>}
                  </div>
                  <div className="tick-label text-faint mt-2">
                    {m.cells.length} ячеек · бонус-колода {m.bonusCards.length} · ловушки {m.trapCards.length}
                  </div>
                  <div className="tick-label mt-1" style={{ color: noTask ? '#ff8b3f' : '#2ee6a8' }}>
                    {noTask ? `Без заданий: ${noTask}` : 'Все задания заполнены'}
                  </div>
                </button>
              );
            })}
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

  const deck = cell ? (cell.type === 'trap' ? map.trapCards : map.bonusCards) : [];
  const effList = effListFor(cell?.type);
  const effSel: EffectType = effList.some((ef) => ef.key === cType) ? cType : 'jail';

  return (
    <div className="h-full crt-grid-bg flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3 border-b-[3px] border-edge bg-[rgba(7,9,18,0.7)] flex-wrap">
        <GhostBtn onClick={() => { setMap(null); setSelCell(null); }}>{Ic.back(14)} Карты</GhostBtn>
        <h1 className="font-display text-lg uppercase tracking-wider text-magma flex items-center gap-2">{Ic.cart(18)} {map.name}</h1>
        {map.ready && <span className="tick-label text-teal">Готова к игре</span>}
        {/* выбор ячейки списком — если по карте кликнуть трудно (мелкие/внахлёст) */}
        <select
          className="field-in px-2 py-1.5 text-[12px] max-w-[230px]"
          value={selCell ?? ''}
          onChange={(e) => { const i = e.target.value === '' ? null : Number(e.target.value); setSelCell(i); if (i !== null) sfx.hover(); }}
        >
          <option value="">Ячейка: выберите…</option>
          {map.cells.map((c, i) => (
            <option key={i} value={i}>
              {`${c.nonumber || c.n === 0 ? 'БЕЗ №' : '№' + c.n} · ${c.type === 'start' ? 'Старт' : c.type === 'task' ? 'Задание' : c.type === 'rest' ? 'Отдых' : c.type === 'bonus' ? 'Бонус' : c.type === 'trap' ? 'Ловушка' : c.type === 'loot' ? 'ЯЩИК' : 'Квиз'}${c.label ? ' · ' + c.label : ''}${c.task ? ' ✓' : ''}`}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <GhostBtn onClick={() => void persist(map)}>{Ic.save(14)} Сохранить</GhostBtn>
          <PxBtn color={issues.length ? 'dim' : 'magma'} onClick={() => void completeMap()}>{Ic.check(14)} Завершить карту</PxBtn>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* левая панель ромов — только когда редактируется ячейка-задание */}
        {cell?.type === 'task' && (
          <div className="w-full lg:w-[264px] shrink-0 border-t-[3px] lg:border-t-0 lg:border-r-[3px] border-edge bg-[rgba(11,14,28,0.85)] overflow-y-auto p-3 max-h-[38vh] lg:max-h-none">
            <div className="flex items-center justify-between mb-2">
              <div className="tick-label">📼 Ромы · {roms.length}</div>
              <span className="tick-label text-faint">клик — выбрать</span>
            </div>
            {romFolders.map((f) => {
              const inF = romsIn(f);
              const open = romFolderOpen(f);
              const pics = (romFolderViews[f] ?? 'list') === 'pics'; // v0.61: дефолт — СПИСОК
              return (
                <div key={`rf-${f}`} className="mb-2">
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => toggleRomFolder(f, !open)}
                      className="flex-1 min-w-0 flex items-center gap-1 text-left cursor-pointer hover:bg-[rgba(255,93,115,0.08)] px-1 py-0.5"
                      title={open ? 'Свернуть' : 'Развернуть'}
                    >
                      <span className={`text-[10px] shrink-0 ${open ? 'text-gold' : 'text-faint'}`}>{open ? '▾' : '▸'}</span>
                      <span className="text-[10px] text-faint shrink-0">📁</span>
                      <span className="font-display text-[10px] uppercase text-dim truncate">{f}</span>
                      <span className="tick-label text-faint shrink-0">· {inF.length}</span>
                    </button>
                    {/* v0.61: СПИСОК ↔ КАРТИНКИ + разворот картинок в отдельном окне */}
                    {inF.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => { setRomFolderViews((s) => ({ ...s, [f]: pics ? 'list' : 'pics' })); sfx.click(); }}
                          title={pics ? 'Показать обычным списком' : 'Показать картинками картриджей/обложек'}
                          className="text-faint hover:text-gold cursor-pointer shrink-0 px-0.5"
                        >
                          {pics ? <span className="text-[11px] leading-none">☰</span> : Ic.grid(11)}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setExpandRomFolder(f); sfx.click(); }}
                          title="Развернуть список картинок этой папки в отдельном окне"
                          className="text-faint hover:text-gold cursor-pointer shrink-0 px-0.5"
                        >
                          <span className="text-[11px] leading-none">⛶</span>
                        </button>
                      </>
                    )}
                  </div>
                  {open && (pics ? (
                    /* v0.61: КАРТИНКИ картриджей/обложек — клик по плитке выбирает ром для задания */
                    <div className="mt-1">
                      <div className="flex items-center gap-1.5 mb-1 px-0.5">
                        <span className="tick-label text-faint shrink-0">размер</span>
                        <input
                          type="range"
                          min={44}
                          max={120}
                          step={2}
                          value={romPicsTileSize}
                          onChange={(e) => setRomPicsTileSize(Number(e.target.value))}
                          className="flex-1 min-w-0 accent-[var(--color-gold)] cursor-pointer"
                          title="Больше — виднее, меньше — больше помещается"
                        />
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {inF.map((r) => (
                          <RomTile
                            key={r.id}
                            rom={r}
                            size={romPicsTileSize}
                            selected={fRom === r.id}
                            onPick={() => pickRom(r)}
                            onCover={(file) => void setRomCoverFor(r, file)}
                            onCropFile={(file) => setRomCropJob({ rom: r, file })}
                            onRemoveCover={() => void clearRomCoverFor(r)}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5 mt-1">{inF.map((r) => romPanelRow(r))}</div>
                  ))}
                </div>
              );
            })}
            {looseRoms.length > 0 && (
              <div className="mb-2">
                <div className={`tick-label mb-1 px-1 ${romFolders.length ? 'text-faint' : 'text-dim'}`}>Без папки · {looseRoms.length}</div>
                <div className="space-y-1.5">{looseRoms.map((r) => romPanelRow(r))}</div>
              </div>
            )}
            {roms.length === 0 && (
              <p className="text-[11px] text-magma leading-tight">Ромов нет — загрузите их в «Запуске эмулятора» (там же они раскладываются по папкам).</p>
            )}
            {roms.length > 0 && romFolders.length > 0 && (
              <p className="text-[10px] text-gold leading-tight mt-1">
                Папки раскрываются кликом — внутри ромы; клик по рому выбирает его для этого задания.
                Доступны ромы <PlatName>NES</PlatName>, <PlatName>SEGA</PlatName> (<PlatName>Mega Drive</PlatName> / <PlatName>Master System</PlatName> / <PlatName>GAME GEAR</PlatName>), <PlatName>SNES</PlatName>, <PlatName>Game Boy/Color</PlatName>, <PlatName>GBA</PlatName>, <PlatName>SEGA 32X</PlatName>, <PlatName>Atari 2600</PlatName>, <PlatName>PC Engine</PlatName>; кнопка 🖼 у папки покажет ромы КАРТИНКАМИ картриджей/обложек, у каждого рома есть 📷 (готовая картинка) и ✂ (вырезать картридж из картинки тем же вырезателем, что тайлы в редакторе карт — клик по вырезанному тайлу ставит его обложкой).
              </p>
            )}
          </div>
        )}
        <div className="flex-1 min-w-0 relative">
          <canvas
            ref={canvasRef}
            className="w-full h-full block select-none"
            style={{ cursor: dragRef.current ? 'grabbing' : 'grab' }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              // ЛЮБОЙ кнопкой можно тащить карту; клик без движения выберет ячейку
              inspectDownRef.current = { x: e.clientX, y: e.clientY };
              dragRef.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
            }}
            onPointerMove={(e) => {
              if (dragRef.current) {
                const d = dragRef.current;
                setView((v) => ({ ...v, x: d.vx - (e.clientX - d.sx) / v.zoom, y: d.vy - (e.clientY - d.sy) / v.zoom }));
              }
            }}
            onPointerUp={(e) => {
              // клик без перетаскивания — выбор ячейки
              const d = inspectDownRef.current;
              inspectDownRef.current = null;
              dragRef.current = null;
              if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) pickCell(e);
            }}
            onPointerLeave={() => { dragRef.current = null; inspectDownRef.current = null; }}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) => setView((v) => ({ ...v, zoom: Math.min(3, Math.max(0.25, v.zoom * Math.exp(-e.deltaY * 0.0012))) }))}
          />
          <div className="absolute bottom-3 left-3 hud-chip pixel-corners px-3 py-2 text-[11px] text-dim">
            Тяните карту мышью · клик по ячейке — редактировать · колесо — зум
          </div>
        </div>

        {/* панель ячейки */}
        <div className="w-full lg:w-[360px] shrink-0 border-t-[3px] lg:border-t-0 lg:border-l-[3px] border-edge bg-[rgba(11,14,28,0.8)] overflow-y-auto p-4 space-y-4">
          {!cell ? (
            <div className="text-center py-10">
              <span className="text-magma inline-block floaty">{Ic.target(44)}</span>
              <p className="font-display uppercase text-paper mt-3">Ячейка не выбрана</p>
              <p className="text-[12px] text-dim mt-1">Кликните по ячейке на карте</p>
            </div>
          ) : (
            <>
              <Panel title={!(cell.nonumber || cell.n === 0) ? `Ячейка №${cell.n}` : 'Ячейка без номера (на круге)'} icon={Ic.target(16)} accent={cell.type === 'bonus' ? 'var(--color-teal)' : cell.type === 'trap' ? 'var(--color-coral)' : 'var(--color-gold)'}>
                <div className="p-3 space-y-3">
                  <div className="flex gap-1 flex-wrap">
                    {((['start', 'task', 'rest', 'bonus', 'trap', 'quiz', ...(map.mode === 'rubg' ? (['loot'] as const) : [])]) as CellType[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => void setCellType(t)}
                        className={`flex-1 py-1.5 font-display text-[9px] uppercase tracking-wide border-2 transition-colors cursor-pointer ${cell.type === t ? (t === 'bonus' ? 'border-teal text-teal bg-teal/10' : t === 'trap' ? 'border-coral text-coral bg-coral/10' : t === 'quiz' ? 'border-sky text-sky bg-sky/10' : t === 'rest' ? 'border-dim text-dim bg-dim/10' : t === 'loot' ? 'border-[#ff8b3f] text-[#ff8b3f] bg-[#ff8b3f]/10' : 'border-gold text-gold bg-gold/10') : 'border-edge text-faint hover:text-dim'}`}
                      >
                        {t === 'start' ? 'Старт' : t === 'task' ? 'Задание' : t === 'rest' ? 'Отдых' : t === 'bonus' ? 'Бонус' : t === 'trap' ? 'Ловушка' : t === 'loot' ? 'Лут.' : 'Квиз'}
                      </button>
                    ))}
                  </div>
                  {cell.type === 'loot' && (
                    <p className="text-[10px] text-[#ff8b3f] leading-tight">ЯЩИК с лутом (только RUBG): одноразовый, вскрывается ОТМЫЧКОЙ (мини-игра «замок»); «открыть силой» (25%) — только когда отмычка сломалась, провал заклинивает ящик навсегда. Внутри — случайный предмет: лечение, оружие, отмычка или карты воровства/стелса.</p>
                  )}
                  {cell.type === 'start' && (
                    <p className="text-[10px] text-teal leading-tight">Стартовая ячейка: игроки начнут партию с неё, задание не нужно. В RUBG НЕ обязательна — бойцы выпрыгивают из самолёта, где хотят.</p>
                  )}
                  {cell.type === 'rest' && (
                    <p className="text-[10px] text-dim leading-tight">Пустая клетка-передышка: ничего не происходит. Ром и карточки не нужны — в «без заданий» она не считается.</p>
                  )}
                  <HoldDeleteButton
                    onFire={() => void delCell()}
                    label="ячейку маршрута"
                    ariaLabel="Удалить ячейку из маршрута"
                    title="Удалить ячейку из маршрута"
                    className="btn-ghost pixel-corners px-4 py-2 text-xs inline-flex items-center justify-center gap-2 w-full"
                  >{Ic.trash(13)} Удалить ячейку из маршрута</HoldDeleteButton>
                </div>
              </Panel>

              {/* оформление «как в монополии» */}
              <Panel title="Оформление ячейки" icon={Ic.pen(16)} accent="var(--color-gold)">
                <div className="p-3 space-y-3">
                  <Field label="Короткое название (видно на карте)">
                    <input className="field-in w-full px-3 py-2 text-sm" maxLength={12} placeholder="Например: БОСС" value={vLabel} onChange={(e) => setVLabel(e.target.value)} />
                  </Field>
                  <Field label="Цвет группы">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {CELL_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => { setVColor(vColor === c ? '' : c); sfx.hover(); }}
                          aria-label={c}
                          className={`w-7 h-7 border-2 cursor-pointer transition-transform hover:scale-110 ${vColor === c ? 'border-paper scale-110' : 'border-abyss'}`}
                          style={{ background: c }}
                        />
                      ))}
                      <button
                        onClick={() => { setVColor(''); sfx.hover(); }}
                        className="w-7 h-7 border-2 border-edge text-faint font-pixel text-[8px] cursor-pointer hover:text-coral"
                        title="Без цвета"
                      >
                        ∅
                      </button>
                    </div>
                  </Field>
                  <Field label="Картинка ячейки (видно на карте)">
                    <div className="flex items-center gap-2">
                      <label className="btn-ghost pixel-corners px-3 py-2 text-[11px] uppercase font-display cursor-pointer inline-flex items-center gap-2">
                        {Ic.upload(13)} Загрузить
                        <input type="file" accept="image/*" className="hidden" onChange={(e) => { void onImg(setVImg)(e.target.files); e.target.value = ''; }} />
                      </label>
                      {vImg && <img src={vImg} alt="" className="h-10 w-10 object-cover border-2 border-edge" />}
                      {vImg && <GhostBtn small onClick={() => setVImg('')}>{Ic.trash(12)}</GhostBtn>}
                    </div>
                  </Field>
                  <PxBtn className="w-full" onClick={() => void saveVisuals()}>{Ic.check(14)} Сохранить оформление</PxBtn>
                </div>
              </Panel>

              {cell.type === 'quiz' ? (
                <Panel title="Квиз-ячейка" icon={Ic.dice(16)} accent="var(--color-sky)">
                  <div className="p-3 space-y-3">
                    <p className="text-[12px] text-dim leading-relaxed">
                      Игрок, вставший сюда, получает случайный квиз из колоды карты. Вопросы создаются в отдельном
                      редакторе — там же настраиваются типы (выбор из 4, текст, музыка, «кот в мешке»), время на ответ и картинки.
                    </p>
                    <div className="hud-chip pixel-corners px-3 py-2 text-[12px] text-sky">
                      Квизов на карте: {(map.quizzes ?? []).length}
                    </div>
                    <PxBtn color="sky" className="w-full" onClick={() => setScreen('quizEditor')}>
                      {Ic.dice(14)} Открыть редактор квизов
                    </PxBtn>
                  </div>
                </Panel>
              ) : cell.type === 'task' ? (
                <Panel title="Задание ячейки" icon={Ic.cart(16)}>
                  <div className="p-3 space-y-3">
                    <Field label="Ром (выбирается в ЛЕВОЙ панели «Ромы»)">
                      {fRom ? (
                        <div className="flex items-center gap-2 border-2 border-gold/60 bg-gold/5 px-2.5 py-2">
                          {(() => {
                            const cur = roms.find((r) => r.id === fRom);
                            return cur ? <CartridgeBadge rom={cur} h={18} /> : null;
                          })()}
                          <span className="font-display text-[11px] uppercase text-gold truncate">✓ {romName(fRom)}</span>
                        </div>
                      ) : (
                        <div className="border-2 border-dashed border-edge px-3 py-2.5 text-[11px] text-dim leading-tight">
                          Ром не выбран — откройте слева панель «📼 Ромы», раскройте папку и кликните по рому.
                        </div>
                      )}
                    </Field>
                    {roms.length === 0 && (
                      <p className="text-[11px] text-magma">Ромов пока нет — загрузите их в «Запуске эмулятора».</p>
                    )}
                    <Field label={`Сохранение · ${romSaves.length}`}>
                      <select className="field-in w-full px-2 py-2 text-sm" value={fSave} onChange={(e) => setFSave(e.target.value)}>
                        <option value="">— без сохранения (старт с начала) —</option>
                        {(['level', 'boss', 'mytask', 'private'] as SaveKind[]).map((k) => {
                          const list = romSaves.filter((s) => saveKindOf(s) === k);
                          if (!list.length) return null;
                          return (
                            <optgroup key={k} label={SAVE_KIND_LABEL[k]}>
                              {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </optgroup>
                          );
                        })}
                      </select>
                    </Field>
                    {fRom && romSaves.some((s) => saveKindOf(s) === 'private') && (
                      <p className="text-[10.5px] text-sky leading-tight">Частные сохранения выбираются ТОЛЬКО здесь — в игре они не предлагаются.</p>
                    )}
                    {fRom && romSaves.length === 0 && (
                      <p className="text-[11px] text-gold">
                        У этого рома нет сохранений — запустите его в эмуляторе и запишите состояния (и для NES, и для SEGA).
                      </p>
                    )}

                    <Field label="Название ячейки">
                      <input className="field-in w-full px-3 py-2 text-sm" placeholder="Например: Felix — уровень 3" value={fTitle} onChange={(e) => setFTitle(e.target.value)} />
                    </Field>
                    <Field label="Описание задания">
                      <textarea className="field-in w-full px-3 py-2 text-sm h-20 resize-none" placeholder="Пройти уровень, не теряя жизней…" value={fDesc} onChange={(e) => setFDesc(e.target.value)} />
                    </Field>
                    <Field label="Картинка ячейки (необязательно)">
                      <div className="flex items-center gap-2">
                        <label className="btn-ghost pixel-corners px-3 py-2 text-[11px] uppercase font-display cursor-pointer inline-flex items-center gap-2">
                          {Ic.upload(13)} Загрузить
                          <input type="file" accept="image/*" className="hidden" onChange={(e) => { void onImg(setFImg)(e.target.files); e.target.value = ''; }} />
                        </label>
                        {fImg && <img src={fImg} alt="" className="h-10 w-16 object-cover border-2 border-edge" />}
                      </div>
                    </Field>
                    <Field label="Пакость для играющего (необязательно)">
                      <select className="field-in w-full px-2 py-2 text-sm" value={fChaos} onChange={(e) => setFChaos(e.target.value)}>
                        <option value="">— без пакости —</option>
                        {CHAOS_LIST.map((c) => <option key={c.kind} value={c.kind}>{c.name}</option>)}
                      </select>
                    </Field>
                    {fChaos && (
                      <p className="text-[10.5px] text-magma leading-tight">😈 {chaosLabel(fChaos as ChaosKind)}: {CHAOS_LIST.find((c) => c.kind === fChaos)?.desc}</p>
                    )}
                    <Field label="Радость за прохождение (награда прошедшему, максимум одна)">
                      <select className="field-in w-full px-2 py-2 text-sm" value={fJoy} onChange={(e) => setFJoy(e.target.value)}>
                        <option value="">— без радости —</option>
                        {JOY_LIST.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
                      </select>
                    </Field>
                    {fJoy && (
                      <p className="text-[10.5px] text-teal leading-tight">🎉 {JOY_LIST.find((j) => j.id === fJoy)?.desc}</p>
                    )}
                    {/* v0.55: КАСТОМНАЯ ЦЕНА ЗАДАНИЯ — награда за победу и цена проигрыша */}
                    <Field label="Цена задания: награда и проигрыш (необязательно)">
                      <div className="space-y-1 border-2 border-[rgba(255,207,63,0.35)] px-2 py-2">
                        <p className="text-[10px] text-dim leading-tight">
                          Пустое поле = <b className="text-paper">стандарт всей карты</b> (монеты: «+ за победу» / «цена пропуска»; HP: +10% / −5%). Заполните число — и это задание будет платиться ПО-СВОЕМУ.
                        </p>
                        <div className="grid grid-cols-2 gap-1.5">
                          <label className="flex items-center gap-1 text-[10px] text-dim" title="Награда за ПОБЕДУ в этом задании, бронза (монетные режимы и QUEST)">
                            <Coin size={11} /> награда<input type="number" min={0} placeholder="стандарт" className="field-in w-full px-1.5 py-1 text-[11px]" value={fWinCoins} onChange={(e) => setFWinCoins(e.target.value)} />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] text-dim" title="Плата за ПРОИГРЫШ/пропуск этого задания, бронза (монетные режимы)">
                            <Coin size={11} /> проигрыш<input type="number" min={0} placeholder="стандарт" className="field-in w-full px-1.5 py-1 text-[11px]" value={fLoseCoins} onChange={(e) => setFLoseCoins(e.target.value)} />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] text-dim" title="Награда за победу в этом задании, % HP (ресурс «полоска HP»)">
                            ❤ награда HP<input type="number" min={0} placeholder="стандарт" className="field-in w-full px-1.5 py-1 text-[11px]" value={fWinHp} onChange={(e) => setFWinHp(e.target.value)} />
                          </label>
                          <label className="flex items-center gap-1 text-[10px] text-coral" title="Плата за проигрыш в этом задании, % HP (QUEST и ресурс «полоска HP»)">
                            ❤ проигрыш HP<input type="number" min={0} placeholder="стандарт" className="field-in w-full px-1.5 py-1 text-[11px]" value={fLoseHp} onChange={(e) => setFLoseHp(e.target.value)} />
                          </label>
                        </div>
                      </div>
                    </Field>
                    {/* v0.68: ЗАЧЁТ ПО КОДУ — условие по памяти эмулятора из CodeSearch */}
                    <Field label="Зачёт по коду — CodeSearch (необязательно)">
                      <div className="space-y-1.5 border-2 border-[rgba(46,230,168,0.4)] px-2 py-2">
                        <p className="text-[10px] text-dim leading-tight">
                          Запустите ром в «Запуске эмулятора», кнопкой <b className="text-teal">CodeSearch</b> найдите адрес
                          (жизни, оружие, счётчик босса — поиск как в ArtMoney) и скопируйте код условия. Вставьте его сюда —
                          тогда задание зачтётся <b className="text-paper">САМО</b>, когда условие выполнится, без «на доверии».
                        </p>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <input
                            className="field-in flex-1 min-w-[200px] px-2 py-1.5 text-[11px] font-mono"
                            placeholder="RPC1:001AB2C8:u8:eq:3"
                            value={codeIn}
                            onChange={(e) => { setCodeIn(e.target.value); setCodeErr(''); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { const c = parseCond(codeIn); if (c) { setFCond(c); sfx.hover(); } else setCodeErr('Не разобрать — нужен код вида RPC1:001AB2C8:u8:eq:3'); } }}
                          />
                          <GhostBtn small onClick={() => { const c = parseCond(codeIn); if (c) { setFCond(c); setCodeErr(''); sfx.hover(); } else setCodeErr('Не разобрать — нужен код вида RPC1:001AB2C8:u8:eq:3'); }} title="Разобрать код условия">Разобрать</GhostBtn>
                          {fCond && <GhostBtn small onClick={() => { setFCond(null); setCodeIn(''); }} title="Убрать зачёт по коду">{Ic.cross(11)}</GhostBtn>}
                        </div>
                        {codeErr && <p className="text-[10.5px] text-coral">{codeErr}</p>}
                        {fCond && (
                          <div className="space-y-1.5">
                            <div className="text-[11px] text-teal font-mono break-all">{formatCond(fCond)}</div>
                            <div className="text-[10.5px] text-dim leading-tight">Задание зачтётся, когда: {memCondText(fCond)}.</div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <select className="field-in px-2 py-1 text-[10px]" value={fCond.t} onChange={(e) => setFCond({ ...fCond, t: e.target.value as CodeType })} title="Тип значения">
                                {(Object.keys(CODE_TYPE_LABEL) as CodeType[]).map((k) => <option key={k} value={k}>{CODE_TYPE_LABEL[k]}</option>)}
                              </select>
                              <select className="field-in px-2 py-1 text-[10px]" value={fCond.op} onChange={(e) => setFCond({ ...fCond, op: e.target.value as CodeOp })} title="Оператор">
                                {(Object.keys(OP_LABEL) as CodeOp[]).map((k) => <option key={k} value={k}>{OP_LABEL[k]}</option>)}
                              </select>
                              <input className="field-in w-24 px-2 py-1 text-[11px]" value={String(fCond.v)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setFCond({ ...fCond, v: n }); }} title="Значение условия" />
                              <input className="field-in w-28 px-2 py-1 text-[11px] font-mono" value={hex8(fCond.a)} onChange={(e) => { const n = parseHex(e.target.value); if (n !== null) setFCond({ ...fCond, a: n }); }} title="Адрес (hex)" />
                            </div>
                            <p className="text-[10px] text-faint leading-tight">Адрес привязан к ЭТОМУ файлу рома. Другой дамп той же игры может не совпасть — тогда пересоберите условие через CodeSearch.</p>
                          </div>
                        )}
                      </div>
                    </Field>
                    {/* v0.68: ПОРАЖЕНИЕ ПО КОДУ — условие провала задания из CodeSearch */}
                    <Field label="Поражение по коду — CodeSearch (необязательно)">
                      <div className="space-y-1.5 border-2 border-[rgba(255,93,115,0.4)] px-2 py-2">
                        <p className="text-[10px] text-dim leading-tight">
                          Тот же код условия, но наоборот: выполнится — задание <b className="text-coral">ПРОВАЛИТСЯ САМО</b>:
                          RUBG/QUEST — как кнопка «Провалено» (−HP; у нуля полоски — поражение партии), челлендж — автоперезапуск.
                          Пример: адрес жизней = 0 — потерял последнюю жизнь, задание провалено.
                        </p>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <input
                            className="field-in flex-1 min-w-[200px] px-2 py-1.5 text-[11px] font-mono"
                            placeholder="RPC1:001AB2C8:u8:le:0"
                            value={codeFailIn}
                            onChange={(e) => { setCodeFailIn(e.target.value); setCodeFailErr(''); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { const c = parseCond(codeFailIn); if (c) { setFCondFail(c); sfx.hover(); } else setCodeFailErr('Не разобрать — нужен код вида RPC1:001AB2C8:u8:eq:3'); } }}
                          />
                          <GhostBtn small onClick={() => { const c = parseCond(codeFailIn); if (c) { setFCondFail(c); setCodeFailErr(''); sfx.hover(); } else setCodeFailErr('Не разобрать — нужен код вида RPC1:001AB2C8:u8:eq:3'); }} title="Разобрать код условия">Разобрать</GhostBtn>
                          {fCondFail && <GhostBtn small onClick={() => { setFCondFail(null); setCodeFailIn(''); }} title="Убрать поражение по коду">{Ic.cross(11)}</GhostBtn>}
                        </div>
                        {codeFailErr && <p className="text-[10.5px] text-coral">{codeFailErr}</p>}
                        {fCondFail && (
                          <div className="space-y-1.5">
                            <div className="text-[11px] text-coral font-mono break-all">{formatCond(fCondFail)}</div>
                            <div className="text-[10.5px] text-dim leading-tight">Задание провалится, когда: {memCondText(fCondFail)}.</div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <select className="field-in px-2 py-1 text-[10px]" value={fCondFail.t} onChange={(e) => setFCondFail({ ...fCondFail, t: e.target.value as CodeType })} title="Тип значения">
                                {(Object.keys(CODE_TYPE_LABEL) as CodeType[]).map((k) => <option key={k} value={k}>{CODE_TYPE_LABEL[k]}</option>)}
                              </select>
                              <select className="field-in px-2 py-1 text-[10px]" value={fCondFail.op} onChange={(e) => setFCondFail({ ...fCondFail, op: e.target.value as CodeOp })} title="Оператор">
                                {(Object.keys(OP_LABEL) as CodeOp[]).map((k) => <option key={k} value={k}>{OP_LABEL[k]}</option>)}
                              </select>
                              <input className="field-in w-24 px-2 py-1 text-[11px]" value={String(fCondFail.v)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setFCondFail({ ...fCondFail, v: n }); }} title="Значение условия" />
                              <input className="field-in w-28 px-2 py-1 text-[11px] font-mono" value={hex8(fCondFail.a)} onChange={(e) => { const n = parseHex(e.target.value); if (n !== null) setFCondFail({ ...fCondFail, a: n }); }} title="Адрес (hex)" />
                            </div>
                            <p className="text-[10px] text-faint leading-tight">Поражение приоритетнее зачёта: если оба условия совпали разом — задание провалено. Адрес привязан к ЭТОМУ файлу рома — другой дамп может не совпасть.</p>
                          </div>
                        )}
                      </div>
                    </Field>
                    {/* v0.71: предупреждение — одно и то же условие записано и в зачёт, и в поражение */}
                    {codeConflict && fCond && (
                      <p className="text-[10.5px] text-coral leading-tight border-2 border-[rgba(255,93,115,0.5)] px-2 py-1.5">
                        ⚠ Зачёт и поражение — ОДНО И ТО ЖЕ условие ({formatCond(fCond)}): совпадение памяти всегда
                        засчитается поражением (оно проверяется первым), а зачёт по коду не наступит никогда.
                        Измените или уберите одно из двух условий — пока они совпадают, задание сохранить нельзя.
                      </p>
                    )}
                    {/* v0.70: ТОЛЬКО ПО КОДУ — ручные кнопки и голосование отключаются */}
                    <Field label="Только по коду (необязательно)">
                      <div className="space-y-1.5 border-2 border-[rgba(255,207,63,0.4)] px-2 py-2">
                        <label className="flex items-start gap-2 cursor-pointer select-none">
                          <input type="checkbox" checked={fCodeOnly} onChange={(e) => { setFCodeOnly(e.target.checked); sfx.hover(); }} className="mt-0.5" />
                          <span className="text-[11px] text-paper leading-tight">
                            Победа и поражение — <b className="text-gold">ТОЛЬКО по коду</b>, без ручного подтверждения
                          </span>
                        </label>
                        <p className="text-[10px] text-dim leading-tight">
                          Галочка выключает для этой ячейки ручные кнопки и голосование: в челлендже — «Прошёл задание» и «Согласен/Нарушил»,
                          в RUBG/QUEST — «ПОБЕДА» и «ПОРАЖЕНИЕ». Останутся только кодовые условия выше — выполнится код зачёта, задание
                          засчитается само, выполнится код поражения — провалится само. Честно для карт, где игроки не доверяют друг другу.
                          Без галочки (по умолчанию) работают И код, И ручное подтверждение.
                        </p>
                        {fCodeOnly && !fCond && !fCondFail && (
                          <p className="text-[10.5px] text-magma leading-tight">
                            ⚠ Коды не заданы: задание нельзя будет ни выполнить, ни провалить. Вставьте хотя бы один код из CodeSearch — или снимите галочку.
                          </p>
                        )}
                      </div>
                    </Field>
                    <PxBtn className="w-full" disabled={codeConflict} title={codeConflict ? 'Сначала исправьте: зачёт и поражение — одинаковое условие' : undefined} onClick={() => void saveTask()}>{Ic.check(14)} Сохранить задание</PxBtn>
                    {cell.task && (
                      <div className="text-[11px] text-teal">Сейчас: «{cell.task.title}» · {romName(cell.task.romId)}{cell.task.code ? ' · зачёт по коду ✓' : ''}{cell.task.codeFail ? ' · поражение по коду ✓' : ''}{cell.task.codeOnly ? ' · только по коду ✓' : ''}</div>
                    )}
                  </div>
                </Panel>
              ) : cell.type === 'rest' ? (
                <Panel title="Передышка" icon={Ic.dice(16)} accent="var(--color-dim)">
                  <div className="p-3 space-y-2">
                    <p className="text-[12px] text-dim leading-relaxed">
                      Пустая ячейка: игрок, вставший сюда, просто отдыхает — задание не запускается, карточка не выпадает,
                      ход переходит дальше. Удобно ставить «перекур» между делами и цеплять с неё стрелки «ПЕРЕХОД» в редакторе карт.
                    </p>
                  </div>
                </Panel>
              ) : (
                <Panel
                  title={`Колода «${cell.type === 'bonus' ? 'Бонусы' : 'Ловушки'}» · ${deck.length}`}
                  icon={cell.type === 'bonus' ? Ic.star(16) : Ic.skull(16)}
                  accent={cell.type === 'bonus' ? 'var(--color-teal)' : 'var(--color-coral)'}
                >
                  <div className="p-3 space-y-2">
                    {deck.map((c) => (
                      <div key={c.id} className="flex items-center gap-2 border-2 border-edge bg-[rgba(0,0,0,0.25)] px-2.5 py-2">
                        {c.imageId
                          ? <CardThumb id={c.imageId} />
                          : <img src={cardArt(c.kind === 'joy' ? 'bonus' : c.kind, c.name)} alt="" className="w-11 h-8 object-cover border border-edge" />}
                        <div className="min-w-0 flex-1">
                          <div className="font-display text-[11px] uppercase text-paper truncate">{c.name}</div>
                          <div className="text-[10px] text-dim leading-tight">{effectLabel(c.effect)}</div>
                        </div>
                        <HoldDeleteButton
                          onFire={() => void delCard(c.id)}
                          label={`карточку «${c.name}»`}
                          ariaLabel="Удалить карточку"
                          title="Удалить карточку"
                          className="text-faint hover:text-coral cursor-pointer shrink-0"
                        >{Ic.trash(14)}</HoldDeleteButton>
                      </div>
                    ))}
                    {deck.length === 0 && (
                      <p className="text-[11px] text-dim">Колода пуста. Пока в ней нет карточек, ячейка «{cell.type === 'bonus' ? 'Бонус' : 'Ловушка'}» не сработает — а завершить карту с пустой колодой нельзя.</p>
                    )}
                    {cell.type === 'bonus' && (
                      <div className="border-t-2 border-edge pt-3 space-y-2">
                        <div className="tick-label text-magma">😈 Пакости — выпадают как бонус и кладутся в инвентарь игрока</div>
                        <p className="text-[10.5px] text-dim leading-tight">Отметьте нужные — они попадут в колоду шансов. Выпавшую пакость игрок потратит на своё задание (усложнит его для следующего) или продаст.</p>
                        <div className="grid gap-1 max-h-[240px] overflow-y-auto pr-1">
                          {CHAOS_LIST.map((c) => {
                            const inDeck = deck.some((x) => x.chaos === c.kind);
                            return (
                              <button
                                key={c.kind}
                                onClick={() => void toggleChaosCard(c.kind)}
                                className={`text-left px-2.5 py-1.5 border-2 transition-colors cursor-pointer text-[11px] ${inDeck ? 'border-magma bg-magma/10 text-paper' : 'border-edge bg-panel text-dim hover:border-edge2'}`}
                                title={c.desc}
                              >
                                <span className={inDeck ? 'text-magma' : 'text-faint'}>{inDeck ? '✔' : '＋'}</span> {c.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="border-t-2 border-edge pt-3 space-y-2.5">
                      <div className="tick-label text-gold">Новая карточка</div>
                      <Field label="Эффект">
                        <select className="field-in w-full px-2 py-2 text-[12px]" value={effSel} onChange={(e) => {
                          const t = e.target.value as EffectType;
                          setCType(t);
                          const meta = EFFECTS.find((x) => x.key === t)!;
                          setCValue(meta.def || 1);
                        }}>
                          {effList.map((ef) => <option key={ef.key} value={ef.key}>{ef.label}</option>)}
                        </select>
                      </Field>
                      {cell.type === 'trap' && (
                        <p className="text-[10px] text-faint leading-tight">Перемещения (сдвиг на N, телепорт на №N, «не туда») убраны из ловушек — рисуйте их стрелками «ПЕРЕХОД» в редакторе карт.</p>
                      )}
                      {EFFECTS.find((x) => x.key === effSel)?.hasValue && (
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-dim">{EFFECTS.find((x) => x.key === effSel)?.unit}</span>
                          <Stepper value={cValue} onChange={setCValue} min={-20} max={60} />
                        </div>
                      )}
                      {EFFECTS.find((x) => x.key === effSel)?.hasTarget && (
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-dim">Номер игрока</span>
                          <Stepper value={cTarget} onChange={setCTarget} min={1} max={4} suffix=" иг." />
                        </div>
                      )}
                      <Field label="Название карточки">
                        <input className="field-in w-full px-3 py-2 text-sm" placeholder="Отпуск на Гавайях" value={cName} onChange={(e) => setCName(e.target.value)} />
                      </Field>
                      <Field label="Описание (необязательно)">
                        <input className="field-in w-full px-3 py-2 text-sm" value={cDesc} onChange={(e) => setCDesc(e.target.value)} />
                      </Field>
                      <Field label="Картинка карточки (необязательно)">
                        <div className="flex items-center gap-2">
                          <label className="btn-ghost pixel-corners px-3 py-2 text-[11px] uppercase font-display cursor-pointer inline-flex items-center gap-2">
                            {Ic.upload(13)} Загрузить
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => { void onImg(setCImg)(e.target.files); e.target.value = ''; }} />
                          </label>
                          {cImg && <img src={cImg} alt="" className="h-10 w-14 object-cover border-2 border-edge" />}
                        </div>
                      </Field>
                      <PxBtn color={cell.type === 'bonus' ? 'teal' : 'coral'} className="w-full" onClick={() => void addCard()}>{Ic.check(14)} Добавить в колоду</PxBtn>
                    </div>
                  </div>
                </Panel>
              )}

              <Panel title="Проверка карты" icon={Ic.check(16)} accent={issues.length ? 'var(--color-coral)' : 'var(--color-teal)'}>
                <div className="p-3 space-y-1.5 text-[11px]">
                  {issues.map((s, i) => <div key={i} className="text-coral">✖ {s}</div>)}
                  {warns.map((s, i) => <div key={i} className="text-magma">▲ {s}</div>)}
                  {!issues.length && !warns.length && <div className="text-teal">✔ Всё в порядке — карту можно завершать</div>}
                  {!issues.length && warns.length > 0 && <div className="text-teal">✔ Завершение доступно</div>}
                </div>
              </Panel>
            </>
          )}
        </div>
      {/* v0.61: развёрнутый список картинок папки ромов — отдельное окно (слайдер размера + прокрутка колёсиком) */}
      {expandRomFolder && (
        <RomPicsModal
          title={expandRomFolder}
          roms={romsIn(expandRomFolder)}
          selectedId={fRom}
          onClose={() => setExpandRomFolder(null)}
          onPick={(r) => { pickRom(r); setExpandRomFolder(null); }}
          onCover={(r, file) => void setRomCoverFor(r, file)}
          onCrop={(r, file) => setRomCropJob({ rom: r, file })}
          onRemoveCover={(r) => void clearRomCoverFor(r)}
        />
      )}
      {/* v0.62→v0.63: НОЖНИЦЫ — окно вырезания картриджа ТОМ ЖЕ вырезателем, что режет тайлы в редакторе карт */}
      {romCropJob && (
        <CartCutModal
          rom={romCropJob.rom}
          file={romCropJob.file}
          onClose={() => setRomCropJob(null)}
          onSave={(url) => { void applyRomCover(romCropJob.rom, url); setRomCropJob(null); }}
        />
      )}
      </div>
    </div>
  );
}

function CardThumb({ id }: { id: string }) {
  const url = useBlobImageUrl(id);
  return url ? <img src={url} alt="" className="w-11 h-8 object-cover border border-edge" /> : <span className="w-11 h-8 bg-panel inline-block border border-edge" />;
}

import { useEffect as useEff2, useState as useSt2 } from 'react';
function useBlobImageUrl(id: string): string | null {
  const [u, setU] = useSt2<string | null>(null);
  useEff2(() => {
    let on = true;
    idbGet<string>('blobs', id).then((v) => { if (on) setU(v ?? null); });
    return () => { on = false; };
  }, [id]);
  return u;
}
