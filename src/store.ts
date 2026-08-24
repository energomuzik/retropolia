import { create } from 'zustand';
import type { GameMap, GameOptions, GameSession, RomDef, SaveDef, TileDef, TokenDef } from './types';
import type { NetInfo, Room } from './net';
import { idbAll, idbGet, idbPut } from './db';
import { builtinTiles } from './assets';
import { setVolume } from './sound';

export type Screen =
  | 'menu' | 'create' | 'join' | 'load' | 'lobby' | 'game'
  | 'mapEditor' | 'tileEditor' | 'taskEditor' | 'quizEditor' | 'tokenEditor'
  | 'editorsHub' | 'emulator' | 'options';

interface Toast { id: number; text: string; kind: 'info' | 'ok' | 'err'; }

interface AppState {
  screen: Screen;
  setScreen: (s: Screen) => void;

  options: GameOptions;
  setOptions: (p: Partial<GameOptions>) => void;

  tiles: TileDef[];
  maps: GameMap[];
  roms: RomDef[];
  saves: SaveDef[];
  tokens: TokenDef[];
  refresh: () => Promise<void>;

  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind']) => void;

  room: Room | null;
  netInfo: NetInfo;
  selfId: string;
  session: GameSession | null;
  sessionMap: GameMap | null;
  boot: (room: Room, isHost: boolean, session: GameSession | null, map: GameMap | null) => void;
  setSession: (s: GameSession | null) => void;
  setNetInfo: (n: NetInfo) => void;
  leaveRoom: () => void;

  /* in-memory кэш ромов/сохранений, полученных по сети (для гостей, у которых их нет в IndexedDB) */
  romCache: Record<string, ArrayBuffer>;
  saveCache: Record<string, unknown>;
  romReadyTick: number; // инкрементируется при получении рома — триггерит перезагрузку эмулятора
  cacheRomData: (romId: string, buf: ArrayBuffer, saveId?: string, saveState?: unknown) => void;
}

const mkSelfId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const useApp = create<AppState>()((set, get) => ({
  screen: 'menu',
  setScreen: (s) => set({ screen: s }),

  options: {
    name: 'ИГРОК',
    broadcast: true,
    autoReloadOnViolation: true,
    showCellNumbers: true,
    volume: 0.6,
    streamFps: 10,
    emuSound: true,
    emuVolume: 1,
    hideUnrevealed: false,
    relay: '',
    relayHub: '',
  },
  setOptions: (p) => {
    const options = { ...get().options, ...p };
    setVolume(options.volume);
    set({ options });
    try { localStorage.setItem('retropolia-options', JSON.stringify({ state: { options } })); } catch { /* noop */ }
  },

  tiles: [],
  maps: [],
  roms: [],
  saves: [],
  tokens: [],
  refresh: async () => {
    const [tiles, maps, roms, saves, tokens] = await Promise.all([
      idbAll<TileDef>('tiles'),
      idbAll<GameMap>('maps'),
      idbAll<RomDef>('roms'),
      idbAll<SaveDef>('saves'),
      idbAll<TokenDef>('tokens'),
    ]);
    let tileList = tiles.map((e) => e.value);
    if (tileList.length === 0) {
      const seeds = builtinTiles();
      await Promise.all(seeds.map((t) => idbPut('tiles', t.id, t)));
      tileList = seeds;
    }
    const sortMaps = maps.map((e) => e.value).sort((a, b) => b.updatedAt - a.updatedAt);
    set({
      tiles: tileList.sort((a, b) => Number(!!a.builtin) - Number(!!b.builtin) || a.createdAt - b.createdAt),
      maps: sortMaps,
      roms: roms.map((e) => e.value).sort((a, b) => a.name.localeCompare(b.name)),
      saves: saves.map((e) => e.value).sort((a, b) => a.slot - b.slot),
      tokens: tokens.map((e) => e.value).sort((a, b) => a.createdAt - b.createdAt),
    });
  },

  toasts: [],
  toast: (text, kind = 'info') => {
    const id = Date.now() + Math.random();
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, text, kind }] }));
    setTimeout(() => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })), 4200);
  },

  room: null,
  netInfo: { online: false, local: true, links: 0, signal: 'connecting', attempts: 0 },
  selfId: mkSelfId(),
  session: null,
  sessionMap: null,
  boot: (room, _isHost, session, map) => set({ room, session, sessionMap: map, screen: 'lobby' }),
  setSession: (s) => set({ session: s }),
  setNetInfo: (n) => set({ netInfo: n }),
  leaveRoom: () => {
    const r = get().room;
    if (r) r.close();
    set({ room: null, session: null, sessionMap: null, romCache: {}, saveCache: {}, romReadyTick: 0, netInfo: { online: false, local: true, links: 0, signal: 'connecting', attempts: 0 } });
  },

  romCache: {},
  saveCache: {},
  romReadyTick: 0,
  cacheRomData: (romId, buf, saveId, saveState) => {
    const st = get();
    const romCache = { ...st.romCache, [romId]: buf };
    const saveCache = saveId !== undefined ? { ...st.saveCache, [saveId]: saveState ?? null } : st.saveCache;
    set({ romCache, saveCache, romReadyTick: st.romReadyTick + 1 });
  },
}));

// Восстанавливаем сохранённые опции при старте
export async function initApp() {
  try {
    const raw = localStorage.getItem('retropolia-options');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { options?: Partial<GameOptions> } };
      if (parsed.state?.options) useApp.getState().setOptions(parsed.state.options);
    }
  } catch { /* noop */ }
  try {
    await useApp.getState().refresh();
  } catch (e) {
    // Сбой IndexedDB не должен вешать загрузку — игра откроется с пустой библиотекой
    console.error('Не удалось прочитать локальную библиотеку:', e);
    useApp.getState().toast('Локальное хранилище недоступно — библиотека пуста', 'err');
  }
}

export async function getRomData(romId: string): Promise<ArrayBuffer | null> {
  const buf = await idbGet<ArrayBuffer>('blobs', `rom-${romId}`);
  return buf ?? null;
}

export async function getBlobText(key: string): Promise<string | null> {
  const v = await idbGet<string>('blobs', key);
  return v ?? null;
}

export { idbGet };

import { useEffect, useState } from 'react';
export function useBlobImage(id?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    if (!id) { setUrl(null); return; }
    // картинка может быть сохранена как сам data-URL, а не ключ в blobs
    if (id.startsWith('data:')) { setUrl(id); return; }
    idbGet<string>('blobs', id).then((v) => { if (on) setUrl(v ?? null); }).catch(() => { if (on) setUrl(null); });
    return () => { on = false; };
  }, [id]);
  return url;
}
