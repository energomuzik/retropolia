import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { AnimPreview, Field, GhostBtn, Ic, Modal, PxBtn, Stepper } from '../ui';
import PixelPaint, { emptyGrid, gridToDataUrl, imageToGrid } from '../PixelPaint';
import { extractTilesFromImage } from '../tilecut';
import type { ExtractInfo } from '../tilecut';
import { idbAll, idbDel, idbGet, idbPut, uid } from '../db';
import type { AnimClip, AnimDef, BossAnimDef, GameMap, SoundDef, TokenAnim, TokenDef, TileGroup, TileImg } from '../types';
import { HoldDeleteButton, rememberDeleted } from '../delGuard';
import { sfx } from '../sound';
import { playOneShot, stopOneShot } from '../loopsnd';

const SIZES = [12, 16, 24, 32];
const MAX_FRAME = 256; // кадры анимаций сжимаются до 256px по большей стороне — карта остаётся лёгкой

const fmtBytes = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
const isAudioFile = (f: File) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name);

/* сжатие кадра (dataUrl → dataUrl); картинки меньше 256px не трогаем */
const shrinkFrame = (dataUrl: string): Promise<string> =>
  new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const mx = Math.max(img.width || 1, img.height || 1);
      if (mx <= MAX_FRAME) { res(dataUrl); return; }
      const k = MAX_FRAME / mx;
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * k));
      cv.height = Math.max(1, Math.round(img.height * k));
      const cx = cv.getContext('2d')!;
      cx.imageSmoothingEnabled = true;
      cx.drawImage(img, 0, 0, cv.width, cv.height);
      res(cv.toDataURL('image/png'));
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });

/* ЗЕРКАЛО кадра по горизонтали (dataUrl → dataUrl) — для тайлов, нарисованных только в одну сторону */
const flipDataUrl = (dataUrl: string): Promise<string> =>
  new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, img.width || 1);
      cv.height = Math.max(1, img.height || 1);
      const cx = cv.getContext('2d')!;
      cx.translate(cv.width, 0);
      cx.scale(-1, 1);
      cx.drawImage(img, 0, 0);
      res(cv.toDataURL('image/png'));
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });

/* Клипы анимированной фишки: idle обязателен, направления — по наличии.
   win/lose — 5-я и 6-я анимации: победа над заданием и поражение (каждая со своим звуком) */
type ClipKey = 'idle' | 'up' | 'down' | 'left' | 'right' | 'win' | 'lose';
const CLIP_META: { key: ClipKey; label: string; hint: string }[] = [
  { key: 'idle', label: 'IDLE · СТОИТ', hint: 'обязательный клип — фишка стоит на месте' },
  { key: 'down', label: '↓ ВНИЗ', hint: 'фишка идёт вниз' },
  { key: 'up', label: '↑ ВВЕРХ', hint: 'фишка идёт вверх' },
  { key: 'left', label: '← ВЛЕВО', hint: 'фишка идёт влево' },
  { key: 'right', label: '→ ВПРАВО', hint: 'фишка идёт вправо' },
  { key: 'win', label: '🏆 ПОБЕДА · 5-я', hint: 'проигрывается ОДИН раз после победы в задании — вместе с ней ячейка разбивается' },
  { key: 'lose', label: '💀 ПОРАЖЕНИЕ · 6-я', hint: 'проигрывается ОДИН раз при провале задания — после неё ход уходит дальше' },
];

interface ClipDraft { fps: number; frames: string[] }
interface AnimDraft { id?: string; name: string; fps: number; frames: string[]; createdAt?: number; sndId?: string }
interface TokDraft { id?: string; name: string; size: number; clips: Record<ClipKey, ClipDraft>; createdAt?: number; sndId?: string; winSndId?: string; loseSndId?: string }
interface BossDraft { id?: string; name: string; clips: Record<BossClipKey, ClipDraft>; createdAt?: number; sndIds?: { idle?: string; win?: string; lose?: string } }
type BossClipKey = 'idle' | 'win' | 'lose';
const BOSS_CLIPS: { key: BossClipKey; label: string; hint: string }[] = [
  { key: 'idle', label: 'IDLE · ЖДЁТ', hint: 'обязательный клип — босс жив, ждёт на ячейке' },
  { key: 'win', label: '🏆 ИГРОК ПОБЕДИЛ', hint: 'босс получает удар игрока — один раз, когда игрок в радиусе победил задание' },
  { key: 'lose', label: '💀 ИГРОК ПАЛ', hint: 'босс бьёт игрока — один раз, когда игрок в радиусе проиграл задание' },
];

const emptyClips = (): Record<ClipKey, ClipDraft> => ({
  idle: { fps: 6, frames: [] },
  up: { fps: 6, frames: [] },
  down: { fps: 6, frames: [] },
  left: { fps: 6, frames: [] },
  right: { fps: 6, frames: [] },
  win: { fps: 6, frames: [] },
  lose: { fps: 6, frames: [] },
});
const emptyBossClips = (): Record<BossClipKey, ClipDraft> => ({
  idle: { fps: 6, frames: [] },
  win: { fps: 6, frames: [] },
  lose: { fps: 6, frames: [] },
});

const DEF_TOKEN_SIZE = 64; // размер фишки на карте по умолчанию = оригинальный размер тайла (клетка)

const checker = { background: 'repeating-conic-gradient(#1a2244 0 25%, #10142a 0 50%) 0 0 / 10px 10px' } as React.CSSProperties;

/* Лента кадров: перестановка стрелками, удаление; рядом — скорость клипа */
function FrameStrip({ clip, onFrames, size = 52 }: {
  clip: ClipDraft;
  onFrames: (frames: string[]) => void;
  size?: number;
}) {
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= clip.frames.length) return;
    const arr = [...clip.frames];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onFrames(arr);
    sfx.hover();
  };
  return (
    <div className="flex gap-1.5 flex-wrap items-start">
      {clip.frames.map((f, i) => (
        <div key={`${i}-${f.slice(-16)}`} className="border-2 border-edge p-0.5" style={checker}>
          <img src={f} alt={`кадр ${i + 1}`} style={{ width: size, height: size, objectFit: 'contain', imageRendering: 'pixelated' }} />
          <div className="flex justify-center gap-0.5 mt-0.5">
            <button onClick={() => move(i, -1)} title="Раньше" className="px-1 text-[9px] text-dim hover:text-gold cursor-pointer">←</button>
            <button onClick={() => onFrames(clip.frames.filter((_, k) => k !== i))} title="Убрать кадр" className="px-1 text-[9px] text-dim hover:text-coral cursor-pointer">×</button>
            <button onClick={() => move(i, 1)} title="Позже" className="px-1 text-[9px] text-dim hover:text-gold cursor-pointer">→</button>
          </div>
        </div>
      ))}
      {clip.frames.length === 0 && (
        <div className="text-[10px] text-faint self-center py-3">Кадров пока нет — кликайте тайлы в ЛЕВОЙ панели</div>
      )}
    </div>
  );
}

/* Звук, прикреплённый к анимации/фишке. Сам выбор происходит КЛИКОМ по звуку
   в ЛЕВОЙ панели (как выбор тайлов-кадров) — здесь только плашка с именем,
   прослушиванием и отвязкой. Сохраняется КОПИЯ dataUrl — звук из библиотеки
   потом можно удалить. */
function SoundAttach({ sounds, value, onDetach }: { sounds: SoundDef[]; value?: string; onDetach: () => void }) {
  const [playing, setPlaying] = useState(false);
  const s = sounds.find((x) => x.id === value) ?? null;
  useEffect(() => () => stopOneShot(), []);
  if (!s) {
    return (
      <div className="border-2 border-dashed border-edge px-3 py-2.5 text-[11px] text-dim leading-tight">
        Звук не прикреплён — откройте слева раздел «🔊 Звуки» и КЛИКНИТЕ по звуку: он прилипнет сюда. Повторный клик по тому же звуку — отвяжет.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-2 border-gold/60 bg-gold/5 px-2.5 py-2">
      <button
        onClick={() => {
          if (playing) { stopOneShot(); setPlaying(false); return; }
          playOneShot(s.dataUrl);
          setPlaying(true);
        }}
        title={playing ? 'Остановить' : 'Прослушать'}
        className="shrink-0 w-7 h-7 border-2 border-gold text-gold bg-gold/10 font-pixel text-[10px] cursor-pointer"
      >{playing ? '■' : '▶'}</button>
      <div className="flex-1 min-w-0">
        <div className="font-display text-[10px] uppercase text-gold truncate">✓ {s.name}</div>
        <div className="tick-label text-faint">{fmtBytes(s.size)} · прикреплён, при сохранении вшьётся копией</div>
      </div>
      <GhostBtn small onClick={() => { stopOneShot(); setPlaying(false); onDetach(); }} title="Отвязать звук">{Ic.cross(11)}</GhostBtn>
    </div>
  );
}

export default function TokenEditor() {
  const { tokens, anims, bossAnims, sounds, animTiles, animGroups, setScreen, refresh, toast } = useApp();
  const [tab, setTab] = useState<'anims' | 'atokens' | 'tokens' | 'bosses'>('anims');

  /* ---------- пиксель-арт редактор ОБЫЧНОЙ фишки: создание И правка существующей.
     srcDataUrl — откуда взята картинка (тайл левой панели / прежняя фишка):
     если её ДОРАБОТАЛИ — результат уезжает в библиотеку, группу «Изменённые» ---------- */
  const [editor, setEditor] = useState<{ grid: (string | null)[]; w: number; h: number; name: string; editId?: string; createdAt?: number; tokenSize?: number; srcDataUrl?: string; touched?: boolean } | null>(null);

  /* ---------- черновики создателей ---------- */
  const [animDraft, setAnimDraft] = useState<AnimDraft | null>(null); // свободная анимация для карт
  const [tokDraft, setTokDraft] = useState<TokDraft | null>(null); // анимированная фишка
  const [bossDraft, setBossDraft] = useState<BossDraft | null>(null); // босс (idle + победа + поражение)
  const [activeClip, setActiveClip] = useState<ClipKey>('idle'); // клип фишки, куда падают кадры
  const [activeBossClip, setActiveBossClip] = useState<BossClipKey>('idle'); // клип босса, куда падают кадры
  /* куда прилипает ЗВУК по клику в левой панели: у фишки три слота (ход/победа/поражение),
     у босса — тоже три (ждёт/победа/поражение), у свободной анимации — один */
  const [sndTarget, setSndTarget] = useState<'snd' | 'win' | 'lose'>('snd');
  const [bossSndTarget, setBossSndTarget] = useState<'idle' | 'win' | 'lose'>('idle');
  const [mirrorMode, setMirrorMode] = useState(false); // ЗЕРКАЛО: следующий клик по тайлу добавит отражённый кадр

  /* ---------- нарезка тайлов (общий экстрактор из tilecut.ts) ---------- */
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const extRef = useRef<HTMLInputElement>(null);
  const [extract, setExtract] = useState<{ file: File; src: string; name: string; busy: boolean; bgMode: 'auto' | 'custom'; bg: string; foundBg: string; thr: number; minSize: number; mergeGap: number; keepText: boolean; tiles: TileImg[] } | null>(null);
  const exInfoRef = useRef<ExtractInfo | null>(null);
  const exRunRef = useRef(0);
  const exTimerRef = useRef<number | null>(null);
  /* скрытые поля загрузки ЗВУКОВ (папка + файлы) */
  const sndFolderRef = useRef<HTMLInputElement>(null);
  const sndFilesRef = useRef<HTMLInputElement>(null);

  const tileById = useMemo(() => new Map(animTiles.map((t) => [t.id, t])), [animTiles]);

  /* «Изменённые тайлы» — отдельная вкладка ВВЕРХУ левой панели (под «Зеркалом кадров»):
     тайлы, доработанные в пикс-редакторе на вкладке «Обычные фишки»; отсюда их удобно
     брать кадрами для анимаций фишек и анимаций карт. В общем списке папок не дублируются */
  const [edOpen, setEdOpen] = useState(true);
  const editedGroups = useMemo(() => (animGroups ?? []).filter((g) => g.kind === 'edited'), [animGroups]);
  const otherGroups = useMemo(() => (animGroups ?? []).filter((g) => g.kind !== 'edited'), [animGroups]);
  const editedTiles = useMemo(
    () => editedGroups.flatMap((g) => g.tids.map((tid) => tileById.get(tid)).filter(Boolean) as TileImg[]),
    [editedGroups, tileById],
  );

  const runExtract = async (base: { file: File; src: string; bgMode: 'auto' | 'custom'; bg: string; thr: number; minSize: number; mergeGap: number; keepText: boolean; name: string }, patch: Partial<typeof base>) => {
    const next = { ...base, ...patch };
    setExtract((ex) => (ex && ex.src === next.src ? { ...ex, ...next, busy: true } : ex));
    const run = ++exRunRef.current;
    try {
      const r = await extractTilesFromImage(next.file, { bgMode: next.bgMode, bg: next.bg, thr: next.thr, minSize: next.minSize, mergeGap: next.mergeGap, keepText: next.keepText }, exInfoRef);
      if (exRunRef.current !== run) return;
      setExtract((ex) => (ex && ex.src === next.src ? { ...ex, tiles: r.tiles, foundBg: r.bg, busy: false } : ex));
      if (!r.tiles.length) toast('Ничего не нашлось: снизьте мин. размер, поменяйте фон или допуск', 'err');
      else sfx.coin();
    } catch {
      if (exRunRef.current !== run) return;
      setExtract((ex) => (ex && ex.src === next.src ? { ...ex, busy: false } : ex));
      toast('Не удалось обработать картинку', 'err');
    }
  };

  const tuneExtract = (patch: { bgMode?: 'auto' | 'custom'; bg?: string; thr?: number; minSize?: number; mergeGap?: number; keepText?: boolean }) => {
    if (!extract) return;
    const base = { ...extract, ...patch };
    setExtract(base);
    if (exTimerRef.current) window.clearTimeout(exTimerRef.current);
    exTimerRef.current = window.setTimeout(() => void runExtract(base, {}), 180);
  };

  const pipetteBg = (e: { clientX: number; clientY: number; currentTarget: HTMLImageElement }) => {
    if (!extract) return;
    const im = e.currentTarget;
    const info = exInfoRef.current;
    if (!info || !im.naturalWidth) return;
    const r = im.getBoundingClientRect();
    const sc0 = Math.min(r.width / im.naturalWidth, r.height / im.naturalHeight);
    const dw = im.naturalWidth * sc0, dh = im.naturalHeight * sc0;
    const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
    const fx = (e.clientX - r.left - ox) / dw;
    const fy = (e.clientY - r.top - oy) / dh;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return;
    const x = Math.min(info.W - 1, Math.round(fx * info.W));
    const y = Math.min(info.H - 1, Math.round(fy * info.H));
    const i = (y * info.W + x) * 4;
    const hex = (v: number) => v.toString(16).padStart(2, '0');
    tuneExtract({ bgMode: 'custom', bg: `#${hex(info.data[i])}${hex(info.data[i + 1])}${hex(info.data[i + 2])}` });
    sfx.hover();
  };

  const openExtract = async (f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Это не картинка', 'err'); return; }
    const name = f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 20) || 'Вырезанное';
    const st = { file: f, src: URL.createObjectURL(f), name, busy: true, bgMode: 'auto' as const, bg: '#000000', foundBg: '', thr: 25, minSize: 6, mergeGap: 1, keepText: false, tiles: [] as TileImg[] };
    setExtract(st);
    sfx.hover();
    await runExtract(st, {});
  };

  const closeExtract = () => {
    if (exTimerRef.current) { window.clearTimeout(exTimerRef.current); exTimerRef.current = null; }
    exRunRef.current++;
    if (extract) URL.revokeObjectURL(extract.src);
    setExtract(null);
  };

  /* ---------- библиотека тайлов для анимаций: ГЛОБАЛЬНАЯ (aniTiles/animGroups в IndexedDB) ---------- */
  const addTileFiles = async (files: FileList | null, kind: 'folder' | 'files' = 'files') => {
    if (!files) return;
    const byFolder = new Map<string, TileImg[]>();
    let count = 0;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const url0 = URL.createObjectURL(f);
      try {
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = url0;
        });
        const k = Math.min(1, 512 / Math.max(img.width || 1, img.height || 1));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * k));
        cv.height = Math.max(1, Math.round(img.height * k));
        const cx = cv.getContext('2d')!;
        cx.imageSmoothingEnabled = true;
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
        let folder: string;
        if (kind === 'folder' && rel.includes('/')) folder = rel.split('/')[0] || 'Папка';
        else if (kind === 'folder') folder = 'Папка';
        else folder = 'Загруженные файлы';
        const t: TileImg = { id: uid('atimg'), name: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 24) || 'тайл', dataUrl: cv.toDataURL('image/png') };
        const arr = byFolder.get(folder);
        if (arr) arr.push(t); else byFolder.set(folder, [t]);
        count++;
      } catch { /* пропускаем нечитаемый файл */ } finally {
        URL.revokeObjectURL(url0);
      }
    }
    if (!count) { toast('Картинок не найдено', 'err'); return; }
    for (const [folder, imgs] of byFolder) {
      for (const t of imgs) await idbPut('animTiles', t.id, t);
      const ex = animGroups.find((g) => g.name === folder && g.kind === kind);
      if (ex) await idbPut('animGroups', ex.id, { ...ex, tids: [...ex.tids, ...imgs.map((i) => i.id)] });
      else {
        const g: TileGroup = { id: uid('ag'), name: folder, tids: imgs.map((i) => i.id), kind };
        await idbPut('animGroups', g.id, g);
      }
    }
    await refresh();
    sfx.coin();
    toast(`Добавлено тайлов: ${count}`, 'ok');
  };

  const toggleGroup = async (g: TileGroup) => {
    await idbPut('animGroups', g.id, { ...g, collapsed: !g.collapsed });
    await refresh();
  };

  const delGroup = async (g: TileGroup) => {
    const tiles = g.tids.map((tid) => tileById.get(tid)).filter(Boolean) as TileImg[];
    rememberDeleted({
      label: `папку «${g.name}»`,
      restore: async () => {
        for (const t of tiles) await idbPut('animTiles', t.id, JSON.parse(JSON.stringify(t)));
        const cur = await idbGet<TileGroup>('animGroups', g.id);
        if (cur) {
          const tids = [...new Set([...cur.tids, ...g.tids])];
          await idbPut('animGroups', cur.id, { ...cur, tids });
        } else {
          await idbPut('animGroups', g.id, JSON.parse(JSON.stringify(g)));
        }
        await refresh();
      },
    });
    for (const tid of g.tids) await idbDel('animTiles', tid);
    await idbDel('animGroups', g.id);
    await refresh();
    sfx.fail();
  };

  const delTile = async (tid: string) => {
    const tile = tileById.get(tid);
    const groupsWith = animGroups.filter((g) => g.tids.includes(tid)).map((g) => ({ id: g.id, name: g.name, tids: [...g.tids] }));
    rememberDeleted({
      label: `тайл «${tile?.name ?? tid}»`,
      restore: async () => {
        if (tile) await idbPut('animTiles', tile.id, JSON.parse(JSON.stringify(tile)));
        for (const g0 of groupsWith) {
          const cur = await idbGet<TileGroup>('animGroups', g0.id);
          if (cur) {
            const tids = cur.tids.includes(tid) ? cur.tids : [...cur.tids, tid];
            await idbPut('animGroups', cur.id, { ...cur, tids });
          } else {
            // группа исчезла — возвращаем её как была, с этим тайлом
            await idbPut('animGroups', g0.id, { ...g0, collapsed: false });
          }
        }
        await refresh();
      },
    });
    await idbDel('animTiles', tid);
    for (const g of animGroups) {
      if (g.tids.includes(tid)) await idbPut('animGroups', g.id, { ...g, tids: g.tids.filter((x) => x !== tid) });
    }
    await refresh();
    sfx.fail();
  };

  /* ---------- ЗВУКИ: библиотека для анимаций и фишек (IndexedDB 'sounds') ----------
     Загрузка пачкой или ПАПКОЙ (поддиректория = папка-спойлер), прослушивание,
     удаление по режиму из Опций (крестики), Ctrl+Z возвращает. */
  const [sndOpen, setSndOpen] = useState<Record<string, boolean>>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { previewRef.current?.pause(); }, []);

  const togglePreview = (s: SoundDef) => {
    if (previewId === s.id && previewRef.current) {
      previewRef.current.pause();
      previewRef.current = null;
      setPreviewId(null);
      return;
    }
    previewRef.current?.pause();
    const a = new Audio(s.dataUrl);
    a.onended = () => { setPreviewId((cur) => (cur === s.id ? null : cur)); };
    a.play().catch(() => undefined);
    previewRef.current = a;
    setPreviewId(s.id);
    sfx.hover();
  };

  const addSoundFiles = async (files: FileList | null, kind: 'folder' | 'files' = 'files') => {
    if (!files) return;
    let count = 0, skipped = 0, big = 0;
    for (const f of Array.from(files)) {
      if (!isAudioFile(f)) { skipped++; continue; }
      const dataUrl = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      }).catch(() => null);
      if (!dataUrl) { skipped++; continue; }
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      const folder = kind === 'folder' && rel.includes('/') ? (rel.split('/')[0] || 'Звуки') : undefined;
      const s: SoundDef = {
        id: uid('snd'),
        name: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 24) || 'звук',
        dataUrl, size: f.size, createdAt: Date.now(),
        ...(folder ? { folder } : {}),
      };
      await idbPut('sounds', s.id, s);
      count++;
      if (f.size > 8 * 1024 * 1024) big++;
    }
    if (!count) { toast('Аудиофайлов не нашлось — подойдут .mp3, .wav, .ogg, .m4a', 'err'); return; }
    await refresh();
    sfx.coin();
    toast(`Звуков добавлено: ${count}${skipped ? ` · пропущено чужих: ${skipped}` : ''}${big ? ` · ⚠ очень большие: ${big} (карта станет тяжелее)` : ''}`, big ? 'info' : 'ok');
  };

  const delSound = async (s: SoundDef) => {
    rememberDeleted({
      label: `звук «${s.name}»`,
      restore: async () => {
        await idbPut('sounds', s.id, JSON.parse(JSON.stringify(s)));
        await refresh();
      },
    });
    if (previewId === s.id) togglePreview(s); // играл — остановим
    await idbDel('sounds', s.id);
    await refresh();
    toast(`Звук «${s.name}» удалён из библиотеки — вшитые копии в анимациях и фишках остались (Ctrl+Z вернёт)`, 'err');
  };

  const delSoundFolder = async (folder: string) => {
    const list = sounds.filter((s) => s.folder === folder);
    if (!list.length) return;
    rememberDeleted({
      label: `папку звуков «${folder}» (${list.length})`,
      restore: async () => {
        for (const s of list) await idbPut('sounds', s.id, JSON.parse(JSON.stringify(s)));
        await refresh();
      },
    });
    for (const s of list) {
      if (previewId === s.id) togglePreview(s);
      await idbDel('sounds', s.id);
    }
    await refresh();
    toast(`Папка звуков «${folder}» удалена (${list.length}) — Ctrl+Z вернёт`, 'err');
  };

  const soundFolders = useMemo(() => [...new Set(sounds.map((s) => s.folder ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [sounds]);
  const looseSounds = useMemo(() => sounds.filter((s) => !s.folder), [sounds]);
  const soundsIn = (folder: string) => sounds.filter((s) => s.folder === folder);

  /* ---------- ВЫБОР ЗВУКА ДЛЯ СОЗДАТЕЛЕЙ КЛИКОМ ПО ЛЕВОЙ ПАНЕЛИ ----------
   Открыт создатель анимации/фишки/босса → клик по звуку прикрепляет его
   к выбранному слоту (у фишки и босса слотов три), повторный клик по тому же —
   отвязывает. Нет открытого создателя → клик просто прослушивает. */
  const draftSndId = bossDraft
    ? (bossDraft.sndIds?.[bossSndTarget] ?? null)
    : tokDraft
      ? (sndTarget === 'snd' ? tokDraft.sndId ?? null : sndTarget === 'win' ? tokDraft.winSndId ?? null : tokDraft.loseSndId ?? null)
      : animDraft?.sndId ?? null;
  const pickSound = (s: SoundDef) => {
    if (bossDraft) {
      setBossDraft((d) => {
        if (!d) return d;
        const cur = d.sndIds ?? {};
        const next = { ...cur, [bossSndTarget]: cur[bossSndTarget] === s.id ? undefined : s.id };
        return { ...d, sndIds: next };
      });
      sfx.hover();
    } else if (tokDraft) {
      setTokDraft((d) => {
        if (!d) return d;
        if (sndTarget === 'win') return { ...d, winSndId: d.winSndId === s.id ? undefined : s.id };
        if (sndTarget === 'lose') return { ...d, loseSndId: d.loseSndId === s.id ? undefined : s.id };
        return { ...d, sndId: d.sndId === s.id ? undefined : s.id };
      });
      sfx.hover();
    } else if (animDraft) {
      setAnimDraft((d) => (d ? { ...d, sndId: d.sndId === s.id ? undefined : s.id } : d));
      sfx.hover();
    } else {
      togglePreview(s);
    }
  };

  const soundRow = (s: SoundDef) => {
    const sel = draftSndId === s.id;
    const draftOpen = !!(animDraft || tokDraft || bossDraft);
    return (
      <div key={s.id} className={`flex items-center gap-1.5 border-2 px-1.5 py-1 transition-colors ${sel ? 'border-gold bg-gold/10' : 'border-edge bg-panel'}`}>
        <button
          onClick={() => togglePreview(s)}
          title={previewId === s.id ? 'Остановить' : 'Прослушать'}
          className={`shrink-0 w-6 h-6 border-2 font-pixel text-[9px] cursor-pointer ${previewId === s.id ? 'border-gold text-gold bg-gold/10' : 'border-edge text-dim hover:text-paper'}`}
        >{previewId === s.id ? '■' : '▶'}</button>
        <button
          onClick={() => pickSound(s)}
          title={sel ? 'Прикреплён — кликните ещё раз, чтобы отвязать' : draftOpen ? 'Клик: прикрепить этот звук' : 'Клик: прослушать (откройте создателя анимации/фишки, чтобы прикрепить)'}
          className="flex-1 min-w-0 text-left cursor-pointer"
        >
          <div className={`font-display text-[10px] uppercase truncate ${sel ? 'text-gold' : 'text-paper'}`}>{sel ? '✓ ' : ''}{s.name}</div>
          <div className="tick-label text-faint">{fmtBytes(s.size)}{sel ? ' · прикреплён' : ''}</div>
        </button>
        <HoldDeleteButton onFire={() => void delSound(s)} label={`звук «${s.name}»`} ariaLabel="Удалить звук" title="Удалить звук из библиотеки" className="text-faint hover:text-coral cursor-pointer shrink-0 px-0.5">{Ic.cross(10)}</HoldDeleteButton>
      </div>
    );
  };


  const addExtractToLibrary = async () => {
    if (!extract || !extract.tiles.length) return;
    const name = extract.name.trim() || 'Вырезанное';
    for (const t of extract.tiles) await idbPut('animTiles', t.id, t);
    const ex = animGroups.find((g) => g.name === name && g.kind === 'extract');
    const newIds = extract.tiles.map((t) => t.id);
    if (ex) await idbPut('animGroups', ex.id, { ...ex, tids: [...ex.tids, ...newIds] });
    else {
      const g: TileGroup = { id: uid('ag'), name, tids: newIds, kind: 'extract' };
      await idbPut('animGroups', g.id, g);
    }
    URL.revokeObjectURL(extract.src);
    setExtract(null);
    await refresh();
    sfx.coin();
    toast('Вырезанные тайлы добавлены в библиотеку', 'ok');
  };

  /* ---------- клик по тайлу левой панели = ДОБАВИТЬ КАДР в открытый черновик,
     а на вкладке «Обычные фишки» (без черновика) — открыть тайл в пиксель-редакторе ---------- */
  const onTileClick = (t: TileImg) => {
    if (!animDraft && !tokDraft && !bossDraft && tab === 'tokens') {
      openTileAsToken(t);
      return;
    }
    const add = async () => {
      let src = t.dataUrl;
      if (mirrorMode) src = await flipDataUrl(src); // ЗЕРКАЛО по горизонтали
      const url = await shrinkFrame(src);
      if (bossDraft) {
        setBossDraft((d) => (d ? { ...d, clips: { ...d.clips, [activeBossClip]: { ...d.clips[activeBossClip], frames: [...d.clips[activeBossClip].frames, url] } } } : d));
        sfx.coin();
        return;
      }
      if (animDraft) {
        setAnimDraft((d) => (d ? { ...d, frames: [...d.frames, url] } : d));
        sfx.coin();
        return;
      }
      if (tokDraft) {
        setTokDraft((d) => (d ? { ...d, clips: { ...d.clips, [activeClip]: { ...d.clips[activeClip], frames: [...d.clips[activeClip].frames, url] } } } : d));
        sfx.coin();
        return;
      }
      toast('Сначала откройте «Новая анимация», «Новая анимированная фишка» или «Новый босс» — тайлы станут кадрами', 'info');
    };
    void add();
  };

  /* тайл из левой панели → фишка: открываем пиксель-редактор с этой картинкой;
     пока ничего не дорисовано, фишка сохраняет ОРИГИНАЛЬНУЮ картинку тайла (без прореживания) */
  const openTileAsToken = (t: TileImg) => {
    const img = new Image();
    img.onload = () => {
      const size = SIZES.find((s) => s >= Math.max(img.width, img.height)) ?? 32;
      const grid = imageToGrid(img, Math.min(img.width, size), Math.min(img.height, size));
      setEditor({
        grid,
        w: Math.min(img.width, size),
        h: Math.min(img.height, size),
        name: t.name.replace(/\.[^.]+$/, '').slice(0, 16).toUpperCase() || 'ФИШКА',
        tokenSize: DEF_TOKEN_SIZE,
        srcDataUrl: t.dataUrl,
      });
      sfx.hover();
    };
    img.src = t.dataUrl;
  };

  /* ДОРАБОТАННЫЙ тайл → библиотека, группа «Изменённые» (спойлер).
     Дубликаты по картинке не плодим; true — добавлен новый тайл */
  const addEditedTile = async (dataUrl: string, name: string): Promise<boolean> => {
    const g = animGroups.find((gr) => gr.kind === 'edited');
    if (g) {
      for (const tid of g.tids) {
        const ex = tileById.get(tid);
        if (ex && ex.dataUrl === dataUrl) return false;
      }
    }
    const id = uid('atimg');
    const t: TileImg = { id, name: (name.trim() || 'изменённый').slice(0, 24), dataUrl };
    await idbPut('animTiles', id, t);
    if (g) await idbPut('animGroups', g.id, { ...g, tids: [...g.tids, id] });
    else {
      const ng: TileGroup = { id: uid('ag'), name: 'Изменённые', tids: [id], kind: 'edited', collapsed: true };
      await idbPut('animGroups', ng.id, ng);
    }
    return true;
  };

  /* ---------- сохранение/удаление сущностей ---------- */
  const saveAnim = async () => {
    if (!animDraft) return;
    if (!animDraft.frames.length) { toast('Добавьте хотя бы один кадр — кликайте тайлы слева', 'err'); sfx.fail(); return; }
    const sndUrl = animDraft.sndId ? sounds.find((x) => x.id === animDraft.sndId)?.dataUrl : undefined;
    const a: AnimDef = {
      id: animDraft.id ?? uid('anim'),
      name: animDraft.name.trim().toUpperCase() || 'АНИМАЦИЯ',
      clip: { fps: Math.max(1, Math.min(24, animDraft.fps)), frames: animDraft.frames },
      ...(sndUrl ? { snd: sndUrl } : {}),
      createdAt: animDraft.createdAt ?? Date.now(),
    };
    await idbPut('anims', a.id, a);
    await refresh();
    setAnimDraft(null);
    sfx.success();
    toast(`Анимация «${a.name}» сохранена${a.snd ? ' со звуком' : ''} — вшивайте её в карты в редакторе карт`, 'ok');
  };

  /* УДАЛЁННАЯ фишка не должна оставаться вшитой в карты: чистим mapTokens всех карт,
     иначе при запуске карты удалённую фишку всё ещё можно выбрать.
     Возвращает снимки прежних списков — для отмены через Ctrl+Z */
  const purgeTokFromMaps = async (tokId: string): Promise<Array<{ key: string; mapTokens: TokenDef[] }>> => {
    const all = await idbAll<GameMap>('maps');
    const snapshots: Array<{ key: string; mapTokens: TokenDef[] }> = [];
    for (const { key, value: mp } of all) {
      const cur = mp.mapTokens ?? [];
      const next = cur.filter((x) => x.id !== tokId);
      if (next.length !== cur.length) {
        snapshots.push({ key, mapTokens: cur.map((x) => ({ ...x })) });
        await idbPut('maps', key, { ...mp, mapTokens: next, updatedAt: Date.now() });
      }
    }
    return snapshots;
  };

  /* УДАЛЁННАЯ анимация: чистим animLib всех карт И снятые с карты анимации с этой ссылкой
     (иначе в редакторе карт остаются битые записи, а анимация — «жива» внутри карты).
     Возвращает снимки прежних списков — для отмены через Ctrl+Z */
  const purgeAnimFromMaps = async (animId: string): Promise<Array<{ key: string; animLib: unknown[]; anims: unknown[] }>> => {
    const all = await idbAll<GameMap>('maps');
    const snapshots: Array<{ key: string; animLib: unknown[]; anims: unknown[] }> = [];
    for (const { key, value: mp } of all) {
      const lib = (mp.animLib ?? []).filter((x) => x.id !== animId);
      const placed = (mp.anims ?? []).filter((x) => x.aid !== animId);
      if (lib.length !== (mp.animLib ?? []).length || placed.length !== (mp.anims ?? []).length) {
        snapshots.push({ key, animLib: mp.animLib ?? [], anims: mp.anims ?? [] });
        await idbPut('maps', key, { ...mp, animLib: lib, anims: placed, updatedAt: Date.now() });
      }
    }
    return snapshots;
  };

  const removeAnim = async (a: AnimDef) => {
    const snaps = await purgeAnimFromMaps(a.id);
    await idbDel('anims', a.id);
    rememberDeleted({
      label: `анимацию «${a.name}»`,
      restore: async () => {
        await idbPut('anims', a.id, JSON.parse(JSON.stringify(a)));
        for (const s of snaps) {
          const cur = await idbGet<GameMap>('maps', s.key);
          if (cur) await idbPut('maps', cur.id, { ...cur, animLib: s.animLib as GameMap['animLib'], anims: s.anims as GameMap['anims'], updatedAt: Date.now() });
        }
        await refresh();
      },
    });
    await refresh();
    toast(`Анимация «${a.name}» удалена — также убрана из всех карт, где была вшита (Ctrl+Z вернёт)`, 'err');
  };

  const saveTok = async () => {
    if (!tokDraft) return;
    if (!tokDraft.clips.idle.frames.length) { toast('Клип IDLE обязателен — добавьте в него кадры (это фишка, когда она стоит)', 'err'); sfx.fail(); return; }
    const tokSndUrl = tokDraft.sndId ? sounds.find((x) => x.id === tokDraft.sndId)?.dataUrl : undefined;
    const winSndUrl = tokDraft.winSndId ? sounds.find((x) => x.id === tokDraft.winSndId)?.dataUrl : undefined;
    const loseSndUrl = tokDraft.loseSndId ? sounds.find((x) => x.id === tokDraft.loseSndId)?.dataUrl : undefined;
    const clipOf = (k: ClipKey) => ({ fps: Math.max(1, Math.min(24, tokDraft.clips[k].fps)), frames: tokDraft.clips[k].frames });
    const anim: TokenAnim = {
      idle: clipOf('idle'),
      ...(tokDraft.clips.up.frames.length ? { up: clipOf('up') } : {}),
      ...(tokDraft.clips.down.frames.length ? { down: clipOf('down') } : {}),
      ...(tokDraft.clips.left.frames.length ? { left: clipOf('left') } : {}),
      ...(tokDraft.clips.right.frames.length ? { right: clipOf('right') } : {}),
      ...(tokDraft.clips.win.frames.length ? { win: clipOf('win') } : {}), // 5-я анимация: победа над заданием
      ...(tokDraft.clips.lose.frames.length ? { lose: clipOf('lose') } : {}), // 6-я анимация: поражение
      ...(tokSndUrl ? { snd: tokSndUrl } : {}),
      ...(winSndUrl ? { winSnd: winSndUrl } : {}), // отдельный звук победы
      ...(loseSndUrl ? { loseSnd: loseSndUrl } : {}), // отдельный звук поражения
    };
    const t: TokenDef = {
      id: tokDraft.id ?? uid('tok'),
      name: tokDraft.name.trim().toUpperCase() || 'ФИШКА',
      dataUrl: tokDraft.clips.idle.frames[0], // превью = первый кадр idle
      createdAt: tokDraft.createdAt ?? Date.now(),
      anim,
      size: Math.max(16, Math.min(320, tokDraft.size)),
    };
    await idbPut('tokens', t.id, t);
    await refresh();
    setTokDraft(null);
    sfx.success();
    toast(`Анимированная фишка «${t.name}» готова${anim.win ? ' · с анимацией ПОБЕДЫ' : ''}${anim.lose ? ' · с анимацией ПОРАЖЕНИЯ' : ''} — отмечайте её в картах`, 'ok');
  };

  /* УДАЛЁННЫЙ босс не должен оставаться вшитым в карты: чистим bossLib + экземпляры.
     Возвращает снимки прежних списков — для отмены через Ctrl+Z */
  const purgeBossFromMaps = async (bossId: string): Promise<Array<{ key: string; bossLib: unknown[]; bosses: unknown[] }>> => {
    const all = await idbAll<GameMap>('maps');
    const snapshots: Array<{ key: string; bossLib: unknown[]; bosses: unknown[] }> = [];
    for (const { key, value: mp } of all) {
      const lib = (mp.bossLib ?? []).filter((x) => x.id !== bossId);
      const placed = (mp.bosses ?? []).filter((x) => x.bid !== bossId);
      if (lib.length !== (mp.bossLib ?? []).length || placed.length !== (mp.bosses ?? []).length) {
        snapshots.push({ key, bossLib: mp.bossLib ?? [], bosses: mp.bosses ?? [] });
        await idbPut('maps', key, { ...mp, bossLib: lib, bosses: placed, updatedAt: Date.now() });
      }
    }
    return snapshots;
  };

  const saveBoss = async () => {
    if (!bossDraft) return;
    if (!bossDraft.clips.idle.frames.length) { toast('Клип IDLE обязателен — добавьте кадры (живой босс на ячейке)', 'err'); sfx.fail(); return; }
    if (!bossDraft.clips.win.frames.length || !bossDraft.clips.lose.frames.length) { toast('Нужны клипы ПОБЕДЫ и ПОРАЖЕНИЯ — это реакции босса на исходы заданий', 'err'); sfx.fail(); return; }
    const sndUrl = (sid?: string) => (sid ? sounds.find((x) => x.id === sid)?.dataUrl : undefined);
    const clipOf = (k: BossClipKey) => ({ fps: Math.max(1, Math.min(24, bossDraft.clips[k].fps)), frames: bossDraft.clips[k].frames });
    const b: BossAnimDef = {
      id: bossDraft.id ?? uid('boss'),
      name: bossDraft.name.trim().toUpperCase() || 'БОСС',
      idle: clipOf('idle'),
      win: clipOf('win'),
      lose: clipOf('lose'),
      ...(sndUrl(bossDraft.sndIds?.idle) ? { idleSnd: sndUrl(bossDraft.sndIds?.idle) } : {}),
      ...(sndUrl(bossDraft.sndIds?.win) ? { winSnd: sndUrl(bossDraft.sndIds?.win) } : {}),
      ...(sndUrl(bossDraft.sndIds?.lose) ? { loseSnd: sndUrl(bossDraft.sndIds?.lose) } : {}),
      createdAt: bossDraft.createdAt ?? Date.now(),
    };
    await idbPut('bossAnims', b.id, b);
    await refresh();
    setBossDraft(null);
    sfx.success();
    toast(`Босс «${b.name}» сохранён — вшивайте его в карты в редакторе карт`, 'ok');
  };

  const removeBoss = async (b: BossAnimDef) => {
    const snaps = await purgeBossFromMaps(b.id);
    await idbDel('bossAnims', b.id);
    rememberDeleted({
      label: `босса «${b.name}»`,
      restore: async () => {
        await idbPut('bossAnims', b.id, JSON.parse(JSON.stringify(b)));
        for (const sn of snaps) {
          const cur = await idbGet<GameMap>('maps', sn.key);
          if (cur) await idbPut('maps', cur.id, { ...cur, bossLib: sn.bossLib as GameMap['bossLib'], bosses: sn.bosses as GameMap['bosses'], updatedAt: Date.now() });
        }
        await refresh();
      },
    });
    await refresh();
    toast(`Босс «${b.name}» удалён — также убран из всех карт, где был вшит (Ctrl+Z вернёт)`, 'err');
  };

  const removeTok = async (t: TokenDef) => {
    const snaps = await purgeTokFromMaps(t.id);
    await idbDel('tokens', t.id);
    rememberDeleted({
      label: `фишку «${t.name}»`,
      restore: async () => {
        await idbPut('tokens', t.id, JSON.parse(JSON.stringify(t)));
        for (const s of snaps) {
          const cur = await idbGet<GameMap>('maps', s.key);
          if (cur) await idbPut('maps', cur.id, { ...cur, mapTokens: s.mapTokens, updatedAt: Date.now() });
        }
        await refresh();
      },
    });
    await refresh();
    toast(`Фишка «${t.name}» удалена — также убрана из всех карт, где была выбрана (Ctrl+Z вернёт)`, 'err');
  };

  /* ---------- обычные фишки: пиксель-арт / PNG / правка ---------- */
  const newBlank = (size: number) => {
    setEditor({ grid: emptyGrid(size, size), w: size, h: size, name: 'ФИШКА', tokenSize: DEF_TOKEN_SIZE });
    sfx.click();
  };

  const editToken = (t: TokenDef) => {
    const img = new Image();
    img.onload = () => {
      const size = SIZES.find((s) => s >= Math.max(img.width, img.height)) ?? 32;
      const grid = imageToGrid(img, Math.min(img.width, size), Math.min(img.height, size));
      setEditor({ grid, w: Math.min(img.width, size), h: Math.min(img.height, size), name: t.name, editId: t.id, createdAt: t.createdAt, tokenSize: t.size ?? DEF_TOKEN_SIZE, srcDataUrl: t.dataUrl });
      sfx.hover();
    };
    img.src = t.dataUrl;
  };

  const save = async () => {
    if (!editor) return;
    const hasPixels = editor.grid.some(Boolean);
    if (!hasPixels) { toast('Нарисуйте что-нибудь — пустая фишка не сохранится', 'err'); return; }
    /* ничего не дорисовано (взяли готовый тайл) — сохраняем ОРИГИНАЛЬНУЮ картинку целиком;
       дорисовали — сохраняем результат пиксель-редактора */
    const finalUrl = editor.touched || !editor.srcDataUrl ? gridToDataUrl(editor.grid, editor.w, editor.h, 4) : editor.srcDataUrl;
    const t: TokenDef = {
      id: editor.editId ?? uid('tok'),
      name: editor.name.trim() || 'ФИШКА',
      dataUrl: finalUrl,
      createdAt: editor.createdAt ?? Date.now(),
      size: Math.max(16, Math.min(320, editor.tokenSize ?? DEF_TOKEN_SIZE)),
    };
    await idbPut('tokens', t.id, t);
    let edited = false;
    if (editor.srcDataUrl && finalUrl !== editor.srcDataUrl) {
      edited = await addEditedTile(finalUrl, editor.name); // доработанный тайл — в библиотеку, «Изменённые»
    }
    await refresh();
    setEditor(null);
    sfx.success();
    toast(`Фишка «${t.name}» сохранена${edited ? ' · доработанный тайл добавлен в панель → «Изменённые»' : ''}`, 'ok');
  };

  const staticToks = tokens.filter((t) => !t.anim);
  const animToks = tokens.filter((t) => !!t.anim);

  return (
    <div className="h-full crt-grid-bg flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3 border-b-[3px] border-edge bg-[rgba(7,9,18,0.7)] flex-wrap">
        <GhostBtn onClick={() => setScreen('editorsHub')}>{Ic.back(14)} Редакторы</GhostBtn>
        <h1 className="font-display text-lg uppercase tracking-wider text-sky flex items-center gap-2">
          <span className="text-sky">{Ic.pawn(18)}</span> Редактор анимаций и фишек
        </h1>
        <div className="ml-auto flex gap-2 flex-wrap">
          {tab === 'tokens' && (
            <GhostBtn onClick={() => newBlank(16)}>{Ic.plus(14)} Нарисовать</GhostBtn>
          )}
          {tab === 'anims' && <PxBtn color="sky" onClick={() => { setAnimDraft({ name: '', fps: 6, frames: [] }); sfx.click(); }}>{Ic.plus(14)} Новая анимация</PxBtn>}
          {tab === 'atokens' && <PxBtn color="sky" onClick={() => { setTokDraft({ name: '', size: DEF_TOKEN_SIZE, clips: emptyClips() }); setActiveClip('idle'); setSndTarget('snd'); sfx.click(); }}>{Ic.plus(14)} Новая анимированная фишка</PxBtn>}
          {tab === 'bosses' && <PxBtn color="sky" onClick={() => { setBossDraft({ name: '', clips: emptyBossClips() }); setActiveBossClip('idle'); setBossSndTarget('idle'); sfx.click(); }}>{Ic.plus(14)} Новый босс</PxBtn>}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* левая колонка: библиотека тайлов с папками и нарезкой */}
        <div className="w-[248px] shrink-0 border-r-[3px] border-edge bg-[rgba(11,14,28,0.75)] overflow-y-auto p-3 space-y-4 hidden md:block">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="tick-label">Тайлы анимаций · {animTiles.length}</div>
              <button onClick={() => filesRef.current?.click()} className="text-[10px] text-sky hover:text-paper cursor-pointer">+ файлы</button>
            </div>
            <div className="flex gap-1.5 mb-2">
              <GhostBtn small className="flex-1" onClick={() => folderRef.current?.click()}>{Ic.upload(12)} Папка</GhostBtn>
              <GhostBtn small className="flex-1" onClick={() => extRef.current?.click()}>✂ Нарезать</GhostBtn>
            </div>
            <button
              onClick={() => { setMirrorMode((v) => !v); sfx.hover(); }}
              title="ЗЕРКАЛО по горизонтали: пока включено, каждый клик по тайлу добавляет ОТРАЖЁННУЮ копию кадра — для тайлов, нарисованных только в одну сторону"
              className={`w-full py-1 mb-2 border-2 font-display text-[9px] uppercase cursor-pointer ${mirrorMode ? 'border-gold text-gold bg-gold/10' : 'border-edge text-faint hover:text-dim'}`}
            >⇋ Зеркало кадров: {mirrorMode ? 'ВКЛ' : 'ВЫКЛ'}</button>

            {/* ---------- «Изменённые тайлы»: всегда вверху, под «Зеркалом кадров» ---------- */}
            <div className="mb-3">
              <button
                onClick={() => setEdOpen((v) => !v)}
                title={edOpen ? 'Свернуть' : 'Развернуть'}
                className="w-full flex items-center gap-1 text-left cursor-pointer hover:bg-[rgba(255,207,63,0.08)] px-1 py-0.5 mb-1"
              >
                <span className={`text-[10px] shrink-0 ${edOpen ? 'text-gold' : 'text-faint'}`}>{edOpen ? '▾' : '▸'}</span>
                <span className="text-[10px] text-gold shrink-0">✎</span>
                <span className="font-display text-[10px] uppercase text-dim truncate">Изменённые тайлы</span>
                <span className="tick-label text-faint shrink-0">· {editedTiles.length}</span>
              </button>
              {edOpen && (
                editedTiles.length ? (
                  <div className="grid grid-cols-4 gap-1.5">
                    {editedTiles.map((t) => (
                      <button
                        key={t.id}
                        title={`${t.name} — клик: добавить кадром (или открыть в пикс-редакторе на вкладке «Обычные фишки»)`}
                        onClick={() => onTileClick(t)}
                        className={`relative aspect-square border-2 border-gold/40 overflow-hidden cursor-pointer transition-transform hover:scale-105 ${(animDraft || tokDraft || bossDraft) ? 'hover:border-gold' : ''}`}
                      >
                        <img src={t.dataUrl} alt={t.name} className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
                        <HoldDeleteButton as="span" onFire={() => void delTile(t.id)} label={t.name} ariaLabel="удалить тайл" title="Удалить тайл" className="absolute top-0 right-0 w-4 h-4 bg-coral text-abyss font-pixel text-[8px] flex items-center justify-center opacity-0 hover:opacity-100 cursor-pointer">×</HoldDeleteButton>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-faint leading-tight px-1">Пока пусто: на вкладке «Обычные фишки» кликните тайл и дорисуйте его — изменённая версия появится здесь и пойдёт в анимации фишек и карт.</p>
                )
              )}
            </div>

            {(otherGroups ?? []).map((g) => {
              const inG = g.tids.map((tid) => tileById.get(tid)).filter(Boolean) as TileImg[];
              const tag = g.kind === 'extract' ? '✂' : g.kind === 'edited' ? '✎' : g.kind === 'folder' ? '›' : '+';
              return (
                <div key={g.id} className="mb-2">
                  <div className="flex items-center gap-1 mb-1">
                    <button
                      onClick={() => void toggleGroup(g)}
                      className="flex-1 min-w-0 flex items-center gap-1 text-left cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                      title={g.collapsed ? 'Развернуть' : 'Свернуть'}
                    >
                      <span className={`text-[10px] shrink-0 ${g.collapsed ? 'text-faint' : 'text-gold'}`}>{g.collapsed ? '▸' : '▾'}</span>
                      <span className="text-[10px] text-faint shrink-0">{tag}</span>
                      <span className="font-display text-[10px] uppercase text-dim truncate">{g.name}</span>
                      <span className="tick-label text-faint shrink-0">· {inG.length}</span>
                    </button>
                    <HoldDeleteButton onFire={() => void delGroup(g)} label={g.name} ariaLabel="Убрать группу" title="Убрать группу и её тайлы из библиотеки" className="text-faint hover:text-coral cursor-pointer shrink-0 px-0.5">{Ic.cross(10)}</HoldDeleteButton>
                  </div>
                  {!g.collapsed && (
                    <div className="grid grid-cols-4 gap-1.5">
                      {inG.map((t) => (
                        <button
                          key={t.id}
                          title={`${t.name} — клик: добавить кадром`}
                          onClick={() => onTileClick(t)}
                          className={`relative aspect-square border-2 overflow-hidden cursor-pointer transition-transform hover:scale-105 ${(animDraft || tokDraft || bossDraft) ? 'border-edge hover:border-gold' : 'border-edge'}`}
                        >
                          <img src={t.dataUrl} alt={t.name} className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
                          <HoldDeleteButton as="span" onFire={() => void delTile(t.id)} label={t.name} ariaLabel="удалить тайл" title="Удалить тайл" className="absolute top-0 right-0 w-4 h-4 bg-coral text-abyss font-pixel text-[8px] flex items-center justify-center opacity-0 hover:opacity-100 cursor-pointer">×</HoldDeleteButton>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {animGroups.length === 0 && (
              <p className="text-[10px] text-faint leading-tight">Загрузите папку с картинками-кадрами, отдельные файлы или нарежьте кадры из спрайт-листа («✂ Нарезать»). Библиотека одна для всех анимаций и фишек.</p>
            )}
            <p className="text-[10px] text-gold leading-tight mt-2">Откройте создание анимации или фишки — и кликайте тайлы здесь: они встанут КАДРАМИ по порядку. На вкладке «Обычные фишки» клик по тайлу откроет его в пиксель-редакторе, а доработанные варианты лягут на вкладку «✎ Изменённые тайлы» вверху панели.</p>
          </div>

          {/* ---------- ЗВУКИ: библиотека для анимаций и фишек ---------- */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="tick-label">🔊 Звуки · {sounds.length}</div>
              <button onClick={() => sndFilesRef.current?.click()} className="text-[10px] text-sky hover:text-paper cursor-pointer">+ файлы</button>
            </div>
            {(animDraft || tokDraft || bossDraft) && (
              <p className="text-[10px] text-gold leading-tight mb-2 border-2 border-gold/40 px-1.5 py-1">Создатель открыт: КЛИКНИТЕ звук — он прикрепится к выбранному слоту {(bossDraft ? 'босса' : tokDraft ? 'фишки' : 'анимации')}. Повторный клик по тому же — отвяжет.</p>
            )}
            <GhostBtn small className="w-full mb-2" onClick={() => sndFolderRef.current?.click()}>{Ic.upload(12)} Папка со звуками</GhostBtn>
            {soundFolders.map((f) => {
              const list = soundsIn(f);
              const open = sndOpen[f] ?? true;
              return (
                <div key={f} className="mb-2">
                  <div className="flex items-center gap-1 mb-1">
                    <button
                      onClick={() => setSndOpen((s) => ({ ...s, [f]: !open }))}
                      className="flex-1 min-w-0 flex items-center gap-1 text-left cursor-pointer hover:bg-[rgba(90,169,255,0.08)] px-1 py-0.5"
                      title={open ? 'Свернуть' : 'Развернуть'}
                    >
                      <span className={`text-[10px] shrink-0 ${open ? 'text-gold' : 'text-faint'}`}>{open ? '▾' : '▸'}</span>
                      <span className="text-[10px] text-faint shrink-0">📁</span>
                      <span className="font-display text-[10px] uppercase text-dim truncate">{f}</span>
                      <span className="tick-label text-faint shrink-0">· {list.length}</span>
                    </button>
                    <HoldDeleteButton onFire={() => void delSoundFolder(f)} label={`папку звуков «${f}» (${list.length})`} ariaLabel="Удалить папку звуков" title="Удалить папку со всеми звуками в ней" className="text-faint hover:text-coral cursor-pointer shrink-0 px-0.5">{Ic.cross(10)}</HoldDeleteButton>
                  </div>
                  {open && <div className="space-y-1">{list.map((s) => soundRow(s))}</div>}
                </div>
              );
            })}
            {looseSounds.length > 0 && (
              <div className="mb-2">
                <div className="tick-label text-faint mb-1 px-1">Без папки · {looseSounds.length}</div>
                <div className="space-y-1">{looseSounds.map((s) => soundRow(s))}</div>
              </div>
            )}
            {sounds.length === 0 && (
              <p className="text-[10px] text-faint leading-tight">Пока звуков нет. Загрузите ПАПКУ (.mp3, .wav, .ogg, .m4a) или отдельные файлы — затем КЛИКНИТЕ звук в этом списке, прикрепив его к анимации или анимированной фишке.</p>
            )}
            <p className="text-[10px] text-gold leading-tight mt-1">Звук вшивается в анимацию КОПИЕЙ — файл из библиотеки потом можно удалить, вшитое не сломается. Длинные записи сделают карту тяжелее: она уезжает игрокам целиком.</p>
          </div>
        </div>

        {/* центр */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {animDraft ? (
            /* ---------- создатель свободной анимации для карт ---------- */
            <div className="max-w-3xl mx-auto p-4 space-y-4">
              <div className="flex items-center gap-2">
                <GhostBtn onClick={() => setAnimDraft(null)}>← К списку</GhostBtn>
                <span className="font-display uppercase text-paper text-sm">Анимация для карт</span>
              </div>
              <div className="pixel-panel pixel-corners p-4 space-y-3">
                <div className="flex items-end gap-3 flex-wrap">
                  <div className="flex-1 min-w-[180px]">
                    <Field label="Название">
                      <input className="field-in w-full px-3 py-2 text-sm" maxLength={20} value={animDraft.name} onChange={(e) => setAnimDraft({ ...animDraft, name: e.target.value.toUpperCase() })} placeholder="ВЕЯЩАЯ ТРАВА" />
                    </Field>
                  </div>
                  <div>
                    <span className="tick-label block mb-1.5">Скорость кадров</span>
                    <Stepper value={animDraft.fps} onChange={(v) => setAnimDraft({ ...animDraft, fps: v })} min={1} max={24} suffix=" кадр/с" />
                  </div>
                  <div>
                    <span className="tick-label block mb-1.5">Превью</span>
                    <div className="w-16 h-16 border-2 border-edge flex items-center justify-center" style={checker}>
                      <AnimPreview frames={animDraft.frames} fps={animDraft.fps} size={56} />
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-gold leading-tight">Выбирайте анимацию КАДР ЗА КАДРОМ: кликайте тайлы в ЛЕВОЙ панели — они встанут по порядку. Стрелками ← → меняйте порядок кадров, × — уберите лишний.</p>
                <FrameStrip clip={{ fps: animDraft.fps, frames: animDraft.frames }} onFrames={(frames) => setAnimDraft({ ...animDraft, frames })} size={64} />
                <div className="pt-1 border-t-2 border-edge space-y-1">
                  <div className="tick-label">🔊 Звук — прикрепляется кликом по ЛЕВОЙ панели</div>
                  <SoundAttach sounds={sounds} value={animDraft.sndId} onDetach={() => setAnimDraft((d) => (d ? { ...d, sndId: undefined } : d))} />
                  <p className="text-[10px] text-faint leading-tight">У анимации со звуком на карте задаётся РАДИУС: фишка играющего вошла в круг — звук играет (только у него), при повторном входе и передаче хода в круге — продолжается; в задании приглушается.</p>
                </div>
                <div className="flex justify-end gap-2">
                  <GhostBtn onClick={() => { stopOneShot(); setAnimDraft(null); }}>Отмена</GhostBtn>
                  <PxBtn color="sky" onClick={() => void saveAnim()}>{Ic.check(14)} Сохранить анимацию</PxBtn>
                </div>
              </div>
            </div>
          ) : tokDraft ? (
            /* ---------- создатель анимированной фишки: 5 клипов ---------- */
            <div className="max-w-3xl mx-auto p-4 space-y-4">
              <div className="flex items-center gap-2">
                <GhostBtn onClick={() => setTokDraft(null)}>← К списку</GhostBtn>
                <span className="font-display uppercase text-paper text-sm">Анимированная фишка</span>
              </div>
              <div className="pixel-panel pixel-corners p-4 space-y-3">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="flex-1 min-w-[180px]">
                  <Field label="Название">
                    <input className="field-in w-full px-3 py-2 text-sm" maxLength={20} value={tokDraft.name} onChange={(e) => setTokDraft({ ...tokDraft, name: e.target.value.toUpperCase() })} placeholder="ГЕРОЙ" />
                  </Field>
                </div>
                <div>
                  <span className="tick-label block mb-1.5">Размер на карте</span>
                  <Stepper value={tokDraft.size} onChange={(v) => setTokDraft({ ...tokDraft, size: v })} min={16} max={320} step={2} suffix=" px" />
                </div>
              </div>
              <p className="text-[11px] text-gold leading-tight">Размер — это сколько фишка занимает на поле в пикселях по большей стороне. По умолчанию 64 — ОРИГИНАЛЬНЫЙ размер тайла (клетки). Клетки на карте можно укрупнить под большие фишки.</p>
              <p className="text-[11px] text-gold leading-tight">Пять клипов: IDLE — фишка стоит на месте (обязателен), и четыре направления движения. Выберите клип (клик по его плашке), затем кликайте тайлы в ЛЕВОЙ панели — кадры встанут по порядку. Нет кадров у направления — при движении играет IDLE.</p>
                {CLIP_META.map((cm) => {
                  const c = tokDraft.clips[cm.key];
                  const on = activeClip === cm.key;
                  return (
                    <div key={cm.key} className={`border-2 p-2.5 space-y-2 ${on ? 'border-gold bg-[rgba(255,207,63,0.06)]' : 'border-edge'}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => { setActiveClip(cm.key); sfx.hover(); }}
                          title={on ? 'Кадры пойдут в этот клип' : 'Выбрать: кадры пойдут сюда'}
                          className={`px-2 py-1 font-display text-[9px] uppercase border-2 cursor-pointer ${on ? 'border-gold text-gold' : 'border-edge text-dim hover:text-paper'}`}
                        >{on ? '● СЮДА' : '○ СЮДА'}</button>
                        <span className="font-display text-[11px] uppercase text-paper">{cm.label}</span>
                        <span className="tick-label text-faint">{cm.hint} · {c.frames.length} кадр.</span>
                        <div className="ml-auto flex items-center gap-2">
                          <span className="tick-label text-faint">скорость</span>
                          <Stepper value={c.fps} onChange={(v) => setTokDraft({ ...tokDraft, clips: { ...tokDraft.clips, [cm.key]: { ...c, fps: v } } })} min={1} max={24} suffix=" кадр/с" />
                          <div className="w-10 h-10 border-2 border-edge flex items-center justify-center" style={checker}>
                            <AnimPreview frames={c.frames} fps={c.fps} size={34} />
                          </div>
                        </div>
                      </div>
                      <FrameStrip clip={c} onFrames={(frames) => setTokDraft({ ...tokDraft, clips: { ...tokDraft.clips, [cm.key]: { ...c, frames } } })} size={44} />
                    </div>
                  );
                })}
                <div className="pt-1 border-t-2 border-edge space-y-2">
                  <div className="tick-label">🔊 Звуки фишки — прикрепляются кликом по ЛЕВОЙ панели</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="tick-label text-faint shrink-0">Куда прикреплять клик:</span>
                    {([
                      { k: 'snd', label: 'ХОД' },
                      { k: 'win', label: '🏆 ПОБЕДУ' },
                      { k: 'lose', label: '💀 ПОРАЖЕНИЕ' },
                    ] as const).map((o) => (
                      <button
                        key={o.k}
                        onClick={() => { setSndTarget(o.k); sfx.hover(); }}
                        className={`px-2 py-1 font-display text-[9px] uppercase border-2 cursor-pointer ${sndTarget === o.k ? 'border-gold text-gold bg-gold/10' : 'border-edge text-dim hover:text-paper'}`}
                      >{sndTarget === o.k ? '● ' : ''}{o.label}</button>
                    ))}
                  </div>
                  <SoundAttach sounds={sounds} value={tokDraft.sndId} onDetach={() => setTokDraft((d) => (d ? { ...d, sndId: undefined } : d))} />
                  <SoundAttach sounds={sounds} value={tokDraft.winSndId} onDetach={() => setTokDraft((d) => (d ? { ...d, winSndId: undefined } : d))} />
                  <SoundAttach sounds={sounds} value={tokDraft.loseSndId} onDetach={() => setTokDraft((d) => (d ? { ...d, loseSndId: undefined } : d))} />
                  <p className="text-[10px] text-faint leading-tight">ХОД — играет, пока фишка движется. 🏆 ПОБЕДА — один раз после победы в задании (вместе с разбиванием ячейки). 💀 ПОРАЖЕНИЕ — один раз при провале (после неё ход уйдёт дальше). Каждый звук вшивается КОПИЕЙ.</p>
                </div>
                <div className="flex justify-end gap-2">
                  <GhostBtn onClick={() => { stopOneShot(); setTokDraft(null); }}>Отмена</GhostBtn>
                  <PxBtn color="sky" onClick={() => void saveTok()}>{Ic.check(14)} Сохранить фишку</PxBtn>
                </div>
              </div>
            </div>
          ) : bossDraft ? (
            /* ---------- создатель босса: idle + победа игрока + поражение игрока ---------- */
            <div className="max-w-3xl mx-auto p-4 space-y-4">
              <div className="flex items-center gap-2">
                <GhostBtn onClick={() => setBossDraft(null)}>← К списку</GhostBtn>
                <span className="font-display uppercase text-paper text-sm">Босс · анимация на ячейке</span>
              </div>
              <div className="pixel-panel pixel-corners p-4 space-y-3">
                <div className="flex items-end gap-3 flex-wrap">
                  <div className="flex-1 min-w-[180px]">
                    <Field label="Название">
                      <input className="field-in w-full px-3 py-2 text-sm" maxLength={20} value={bossDraft.name} onChange={(e) => setBossDraft({ ...bossDraft, name: e.target.value.toUpperCase() })} placeholder="ДРАКОН" />
                    </Field>
                  </div>
                  <div>
                    <span className="tick-label block mb-1.5">Превью idle</span>
                    <div className="w-16 h-16 border-2 border-edge flex items-center justify-center" style={checker}>
                      <AnimPreview frames={bossDraft.clips.idle.frames} fps={bossDraft.clips.idle.fps} size={56} />
                    </div>
                  </div>
                </div>
                <p className="text-[11px] text-gold leading-tight">Босс ставится на любую ячейку в редакторе карт и ЖДЁТ (idle). Когда игрок В РАДИУСЕ его звука побеждает или проигрывает задание — босс ОДИН раз проигрывает реакцию со своим звуком: «🏆 победа» — босс получает удар игрока, «💀 поражение» — босс бьёт игрока. Если игрок победил задание НА ЯЧЕЙКЕ БОССА и поставил СВОЁ — босс повержен: замер на статичном кадре победы.</p>
                {BOSS_CLIPS.map((cm) => {
                  const c = bossDraft.clips[cm.key];
                  const on = activeBossClip === cm.key;
                  return (
                    <div key={cm.key} className={`border-2 p-2.5 space-y-2 ${on ? 'border-gold bg-[rgba(255,207,63,0.06)]' : 'border-edge'}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => { setActiveBossClip(cm.key); sfx.hover(); }}
                          title={on ? 'Кадры пойдут в этот клип' : 'Выбрать: кадры пойдут сюда'}
                          className={`px-2 py-1 font-display text-[9px] uppercase border-2 cursor-pointer ${on ? 'border-gold text-gold' : 'border-edge text-dim hover:text-paper'}`}
                        >{on ? '● СЮДА' : '○ СЮДА'}</button>
                        <span className="font-display text-[11px] uppercase text-paper">{cm.label}</span>
                        <span className="tick-label text-faint">{cm.hint} · {c.frames.length} кадр.</span>
                        <div className="ml-auto flex items-center gap-2">
                          <span className="tick-label text-faint">скорость</span>
                          <Stepper value={c.fps} onChange={(v) => setBossDraft({ ...bossDraft, clips: { ...bossDraft.clips, [cm.key]: { ...c, fps: v } } })} min={1} max={24} suffix=" кадр/с" />
                          <div className="w-10 h-10 border-2 border-edge flex items-center justify-center" style={checker}>
                            <AnimPreview frames={c.frames} fps={c.fps} size={34} />
                          </div>
                        </div>
                      </div>
                      <FrameStrip clip={c} onFrames={(frames) => setBossDraft({ ...bossDraft, clips: { ...bossDraft.clips, [cm.key]: { ...c, frames } } })} size={44} />
                    </div>
                  );
                })}
                <div className="pt-1 border-t-2 border-edge space-y-2">
                  <div className="tick-label">🔊 Звуки босса — прикрепляются кликом по ЛЕВОЙ панели</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="tick-label text-faint shrink-0">Куда прикреплять клик:</span>
                    {([
                      { k: 'idle', label: 'ЖДЁТ' },
                      { k: 'win', label: '🏆 ПОБЕДУ' },
                      { k: 'lose', label: '💀 ПОРАЖЕНИЕ' },
                    ] as const).map((o) => (
                      <button
                        key={o.k}
                        onClick={() => { setBossSndTarget(o.k); sfx.hover(); }}
                        className={`px-2 py-1 font-display text-[9px] uppercase border-2 cursor-pointer ${bossSndTarget === o.k ? 'border-gold text-gold bg-gold/10' : 'border-edge text-dim hover:text-paper'}`}
                      >{bossSndTarget === o.k ? '● ' : ''}{o.label}</button>
                    ))}
                  </div>
                  <SoundAttach sounds={sounds} value={bossDraft.sndIds?.idle} onDetach={() => setBossDraft((d) => (d ? { ...d, sndIds: { ...d.sndIds, idle: undefined } } : d))} />
                  <SoundAttach sounds={sounds} value={bossDraft.sndIds?.win} onDetach={() => setBossDraft((d) => (d ? { ...d, sndIds: { ...d.sndIds, win: undefined } } : d))} />
                  <SoundAttach sounds={sounds} value={bossDraft.sndIds?.lose} onDetach={() => setBossDraft((d) => (d ? { ...d, sndIds: { ...d.sndIds, lose: undefined } } : d))} />
                  <p className="text-[10px] text-faint leading-tight">ЖДЁТ — фоновый звук живого босса (у экземпляра на карте задаётся радиус). 🏆 и 💀 — звучат ОДИН раз вместе с реакцией, если игрок в радиусе. Все звуки вшиваются КОПИЕЙ.</p>
                </div>
                <div className="flex justify-end gap-2">
                  <GhostBtn onClick={() => { stopOneShot(); setBossDraft(null); }}>Отмена</GhostBtn>
                  <PxBtn color="sky" onClick={() => void saveBoss()}>{Ic.check(14)} Сохранить босса</PxBtn>
                </div>
              </div>
            </div>
          ) : (
            /* ---------- списки по вкладкам ---------- */
            <div className="max-w-4xl mx-auto p-4">
              <div className="flex gap-1.5 mb-4 flex-wrap">
                {([
                  { k: 'anims', label: `Анимации для карт · ${anims.length}` },
                  { k: 'atokens', label: `Анимированные фишки · ${animToks.length}` },
                  { k: 'bosses', label: `👹 Боссы · ${bossAnims.length}` },
                  { k: 'tokens', label: `Обычные фишки · ${staticToks.length}` },
                ] as const).map((t) => (
                  <button
                    key={t.k}
                    onClick={() => { setTab(t.k); sfx.hover(); }}
                    className={`px-3 py-1.5 font-display text-[10px] uppercase tracking-wide border-2 cursor-pointer ${tab === t.k ? 'border-sky text-sky bg-sky/10' : 'border-edge text-dim hover:text-paper'}`}
                  >{t.label}</button>
                ))}
              </div>

              {tab === 'anims' && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {anims.map((a) => (
                    <div key={a.id} className="pixel-panel pixel-corners p-3 text-center">
                      <div className="mx-auto w-20 h-20 flex items-center justify-center border-2 border-edge" style={checker}>
                        <AnimPreview frames={a.clip.frames} fps={a.clip.fps} size={72} />
                      </div>
                      <div className="font-display text-[11px] uppercase text-paper truncate mt-2">{a.name}</div>
                      <div className="tick-label text-faint">{a.clip.frames.length} кадр. · {a.clip.fps} кадр/с</div>
                      <div className="flex justify-center gap-2 mt-2">
                        <GhostBtn small onClick={() => { setAnimDraft({ id: a.id, name: a.name, fps: a.clip.fps, frames: [...a.clip.frames], createdAt: a.createdAt, sndId: sounds.find((x) => x.dataUrl === a.snd)?.id }); sfx.hover(); }} className="!px-2">Изменить</GhostBtn>
                        <HoldDeleteButton onFire={() => void removeAnim(a)} label={a.name} ariaLabel="Удалить анимацию">{Ic.trash(15)}</HoldDeleteButton>
                      </div>
                    </div>
                  ))}
                  {anims.length === 0 && (
                    <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm col-span-full">
                      Анимаций пока нет. Нажмите «Новая анимация», выбирайте кадры из левой панели и задайте скорость — готовое вшивается в карты и размещается на поле.
                    </div>
                  )}
                </div>
              )}

              {tab === 'atokens' && (
                <div>
                  <p className="text-[12px] text-dim mb-3 max-w-2xl">
                    Анимированная фишка — это СЕМЬ клипов: IDLE (стоит), четыре направления движения, 🏆 ПОБЕДА (5-я анимация — один раз после победы в задании, ячейка разбивается) и 💀 ПОРАЖЕНИЕ (6-я — один раз при провале, после неё ход уходит дальше). У каждого клипа свои кадры и скорость, у фишки — три звука: ход, победа и поражение. Отметьте её в редакторе карты («Фишки партии»).
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
                    {animToks.map((t) => (
                      <div key={t.id} className="pixel-panel pixel-corners p-3 text-center">
                        <div className="mx-auto w-20 h-20 flex items-center justify-center border-2 border-edge" style={checker}>
                          <AnimPreview frames={t.anim!.idle.frames} fps={t.anim!.idle.fps} size={72} />
                        </div>
                        <div className="font-display text-[11px] uppercase text-paper truncate mt-2">{t.name}</div>
                        <div className="tick-label text-faint">{(['up', 'down', 'left', 'right'] as const).filter((d) => t.anim![d]?.frames.length).length} напр.{t.anim!.win?.frames.length ? ' · 🏆' : ''}{t.anim!.lose?.frames.length ? ' · 💀' : ''} · {t.anim!.idle.frames.length} кадр. idle</div>
                        <div className="flex justify-center gap-2 mt-2">
                          <GhostBtn small onClick={() => {
                            const a = JSON.parse(JSON.stringify(t.anim)) as TokenAnim;
                            setTokDraft({ id: t.id, name: t.name, createdAt: t.createdAt, size: t.size ?? DEF_TOKEN_SIZE, sndId: sounds.find((x) => x.dataUrl === a.snd)?.id, winSndId: sounds.find((x) => x.dataUrl === a.winSnd)?.id, loseSndId: sounds.find((x) => x.dataUrl === a.loseSnd)?.id, clips: { idle: a.idle, up: a.up ?? { fps: 6, frames: [] }, down: a.down ?? { fps: 6, frames: [] }, left: a.left ?? { fps: 6, frames: [] }, right: a.right ?? { fps: 6, frames: [] }, win: a.win ?? { fps: 6, frames: [] }, lose: a.lose ?? { fps: 6, frames: [] } } });
                            setActiveClip('idle');
                            setSndTarget('snd');
                            sfx.hover();
                          }} className="!px-2">Изменить</GhostBtn>
                          <HoldDeleteButton onFire={() => void removeTok(t)} label={t.name} ariaLabel="Удалить фишку">{Ic.trash(15)}</HoldDeleteButton>
                        </div>
                      </div>
                    ))}
                    {animToks.length === 0 && (
                      <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm col-span-full">
                        Анимированных фишек пока нет. Нажмите «Новая анимированная фишка»: соберите IDLE и направления из тайлов левой панели.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'bosses' && (
                <div>
                  <p className="text-[12px] text-dim mb-3 max-w-2xl">
                    Босс — анимация-персонаж для ячейки карты: живой босс играет IDLE, а когда игрок в радиусе его звука побеждает или проигрывает задание, босс ОДИН раз реагирует клипом победы/поражения со своим звуком. Победил задание на ячейке босса и поставил своё — босс повержен и замер на статичном кадре.
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
                    {bossAnims.map((b) => (
                      <div key={b.id} className="pixel-panel pixel-corners p-3 text-center">
                        <div className="mx-auto w-20 h-20 flex items-center justify-center border-2 border-edge" style={checker}>
                          <AnimPreview frames={b.idle.frames} fps={b.idle.fps} size={72} />
                        </div>
                        <div className="font-display text-[11px] uppercase text-paper truncate mt-2">{b.idleSnd ? '🔊 ' : ''}{b.name}</div>
                        <div className="tick-label text-faint">🏆 {b.win.frames.length} к. · 💀 {b.lose.frames.length} к.</div>
                        <div className="flex justify-center gap-2 mt-2">
                          <GhostBtn small onClick={() => {
                            const findSnd = (url?: string) => sounds.find((x) => x.dataUrl === url)?.id;
                            setBossDraft({ id: b.id, name: b.name, createdAt: b.createdAt, clips: { idle: JSON.parse(JSON.stringify(b.idle)), win: JSON.parse(JSON.stringify(b.win)), lose: JSON.parse(JSON.stringify(b.lose)) }, sndIds: { idle: findSnd(b.idleSnd), win: findSnd(b.winSnd), lose: findSnd(b.loseSnd) } });
                            setActiveBossClip('idle');
                            setBossSndTarget('idle');
                            sfx.hover();
                          }} className="!px-2">Изменить</GhostBtn>
                          <HoldDeleteButton onFire={() => void removeBoss(b)} label={b.name} ariaLabel="Удалить босса">{Ic.trash(15)}</HoldDeleteButton>
                        </div>
                      </div>
                    ))}
                    {bossAnims.length === 0 && (
                      <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm col-span-full">
                        Боссов пока нет. Нажмите «Новый босс»: соберите IDLE и реакции победы/поражения из тайлов левой панели, прикрепите звуки.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'tokens' && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
                  {staticToks.map((t) => (
                    <div key={t.id} className="pixel-panel pixel-corners p-3 text-center">
                      <div className="mx-auto w-20 h-20 flex items-center justify-center border-2 border-edge" style={checker}>
                        <img src={t.dataUrl} alt={t.name} className="max-w-full max-h-full" style={{ imageRendering: 'pixelated' }} />
                      </div>
                      <div className="font-display text-[11px] uppercase text-paper truncate mt-2">{t.name}</div>
                      <div className="flex justify-center gap-2 mt-2">
                        <GhostBtn small onClick={() => editToken(t)} className="!px-2">Изменить</GhostBtn>
                        <HoldDeleteButton onFire={() => void removeTok(t)} label={t.name} ariaLabel="Удалить фишку">{Ic.trash(15)}</HoldDeleteButton>
                      </div>
                    </div>
                  ))}
                  {staticToks.length === 0 && (
                    <div className="pixel-corners border-[3px] border-dashed border-edge p-6 text-center text-dim text-sm col-span-full">
                      Обычных фишек нет — нарисуйте пиксель-арт или кликните тайл в ЛЕВОЙ панели (он откроется в редакторе). Фишки БЕЗ анимации остаются полноценными: их можно выбирать в партиях.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* скрытые поля выбора файлов */}
      <input ref={folderRef} type="file" multiple accept="image/*" style={{ display: 'none' }} {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)} onChange={(e) => { void addTileFiles(e.target.files, 'folder'); e.currentTarget.value = ''; }} />
      <input ref={filesRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={(e) => { void addTileFiles(e.target.files, 'files'); e.currentTarget.value = ''; }} />
      <input ref={extRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { void openExtract(e.target.files?.[0]); e.currentTarget.value = ''; }} />
      <input ref={sndFolderRef} type="file" multiple accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" style={{ display: 'none' }} {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)} onChange={(e) => { void addSoundFiles(e.target.files, 'folder'); e.currentTarget.value = ''; }} />
      <input ref={sndFilesRef} type="file" multiple accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" style={{ display: 'none' }} onChange={(e) => { void addSoundFiles(e.target.files, 'files'); e.currentTarget.value = ''; }} />

      {extract && (
        <Modal title="Нарезка кадров из картинки" icon={Ic.pawn(16)} onClose={closeExtract} w="max-w-2xl">
          <p className="text-[12px] text-dim mb-3">
            Картинка с кадрами на однотонном фоне. Укажите фон (клик по превью = пипетка, или АВТО/палитра), подберите допуск, минимальный размер и склейку — нарезка пересчитается сама. Результат ляжет в библиотеку тайлов отдельной группой.
          </p>
          <div className="flex gap-3 mb-3">
            <img
              src={extract.src}
              alt="исходник"
              onClick={pipetteBg}
              className="w-36 h-36 shrink-0 object-contain border-2 border-edge bg-[repeating-conic-gradient(#141833_0_25%,#0b0e1c_0_50%)_0_0/12px_12px] cursor-crosshair"
              title="Клик — взять цвет фона пипеткой"
            />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-dim shrink-0">Фон:</span>
                <button onClick={() => tuneExtract({ bgMode: 'auto' })} className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${extract.bgMode === 'auto' ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`} title="Найти фон автоматически">АВТО</button>
                <input type="color" value={extract.bg} onChange={(e) => tuneExtract({ bgMode: 'custom', bg: e.target.value })} className="w-8 h-8 border-2 border-edge bg-transparent cursor-pointer p-0" title="Цвет фона палитрой" />
                <span className="tick-label text-faint truncate">{extract.bgMode === 'custom' ? extract.bg : (extract.foundBg || '…')}</span>
              </div>
              <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Допуск фона</span><Stepper value={extract.thr} onChange={(v) => tuneExtract({ thr: v })} min={0} max={200} step={5} /></div>
              <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Мин. размер (px)</span><Stepper value={extract.minSize} onChange={(v) => tuneExtract({ minSize: v })} min={2} max={120} step={2} /></div>
              <div className="flex items-center justify-between"><span className="text-[11px] text-dim">Склейка частей (px)</span><Stepper value={extract.mergeGap} onChange={(v) => tuneExtract({ mergeGap: v })} min={0} max={20} step={1} /></div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-dim">Мелкий текст (подписи)</span>
                <button onClick={() => tuneExtract({ keepText: !extract.keepText })} className={`px-2 py-1 text-[9px] font-pixel border-2 cursor-pointer ${extract.keepText ? 'border-gold text-gold' : 'border-edge text-faint hover:text-dim'}`}>{extract.keepText ? 'ОСТАВИТЬ' : 'ВЫБРОСИТЬ'}</button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-dim shrink-0">Название:</span>
                <input className="field-in flex-1 min-w-0 px-2 py-1 text-[12px]" maxLength={20} value={extract.name} onChange={(e) => setExtract((ex) => (ex ? { ...ex, name: e.target.value } : ex))} />
              </div>
              {extract.busy && <div className="text-gold font-display text-[10px] uppercase animate-pulse">Нарезаю…</div>}
            </div>
          </div>
          {extract.tiles.length > 0 && (
            <div className="grid grid-cols-8 gap-1.5 mb-3 max-h-44 overflow-y-auto border-2 border-edge p-1.5 bg-[rgba(11,14,28,0.6)]">
              {extract.tiles.map((t) => (
                <div key={t.id} className="aspect-square border border-edge bg-[repeating-conic-gradient(#141833_0_25%,#0b0e1c_0_50%)_0_0/8px_8px] overflow-hidden" title={`Кадр ${t.name}`}>
                  <img src={t.dataUrl} alt={t.name} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <GhostBtn onClick={closeExtract}>Отмена</GhostBtn>
            <PxBtn color="sky" onClick={() => void addExtractToLibrary()} disabled={!extract.tiles.length || extract.busy}>
              {Ic.plus(12)} В библиотеку ({extract.tiles.length})
            </PxBtn>
          </div>
        </Modal>
      )}

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
                <span className="tick-label block mb-1.5">Размер на карте</span>
                <Stepper value={editor.tokenSize ?? 64} onChange={(v) => setEditor({ ...editor, tokenSize: v })} min={16} max={320} step={2} suffix=" px" />
              </div>
              <div>
                <span className="tick-label block mb-1.5">Новый холст</span>
                <div className="flex gap-1.5">
                  {SIZES.map((sz) => (
                    <button key={sz} onClick={() => newBlank(sz)} className="btn-ghost pixel-corners px-2.5 py-1.5 text-[11px] cursor-pointer">{sz}²</button>
                  ))}
                </div>
              </div>
            </div>
            <p className="text-[11px] text-faint leading-tight">Размер на карте — сколько фишка занимает на поле (по умолчанию 64 = размер тайла). Картинка фишки впишется в этот размер целиком, пропорции сохранятся.</p>
            <PixelPaint grid={editor.grid} w={editor.w} h={editor.h} onChange={(g) => setEditor({ ...editor, grid: g, touched: true })} />
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
