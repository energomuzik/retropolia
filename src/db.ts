const DB_NAME = 'retropolia-db';
import type { GameMap, RomDef, SaveDef } from './types';
// v2: добавлено хранилище 'tokens' (фишки игроков)
// v3: добавлены 'anims' (анимации автора), 'animTiles' и 'animGroups' (библиотека тайлов редактора анимаций)
// v4: добавлено 'sounds' (звуковая библиотека для анимаций карт и фишек)
// v5: добавлено 'bossAnims' (боссы: idle + реакции на победу/поражение со звуками)
// v6: добавлено 'challenges' (свои челленджи из мастера «Создать челлендж»)
const DB_VERSION = 6;
export const STORES = ['tiles', 'maps', 'roms', 'saves', 'blobs', 'sessions', 'tokens', 'anims', 'animTiles', 'animGroups', 'sounds', 'bossAnims', 'challenges'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null; // даём шанс повторить открытие
      reject(req.error);
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('IndexedDB заблокирована другой вкладкой — закройте старые вкладки игры'));
    };
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idbPut = (store: StoreName, key: string, value: unknown) =>
  tx(store, 'readwrite', (s) => s.put(value, key));

export const idbGet = <T,>(store: StoreName, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);

export const idbDel = (store: StoreName, key: string) => tx(store, 'readwrite', (s) => s.delete(key));

export async function idbAll<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const s = t.objectStore(store);
    const out: { key: string; value: T }[] = [];
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        out.push({ key: String(c.key), value: c.value as T });
        c.continue();
      } else resolve(out);
    };
    cur.onerror = () => reject(cur.error);
  });
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------- экспорт / импорт всей библиотеки (тайлы, карты, ромы, сохранения, фишки) ---------- */

function abToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

function b64ToAb(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const ab = new ArrayBuffer(bin.length);
  new Uint8Array(ab).set(u8);
  return ab;
}

const ser = (v: unknown): unknown => {
  if (v instanceof ArrayBuffer) return { __b64: abToB64(v) };
  if (v instanceof Uint8Array) {
    const ab = new ArrayBuffer(v.byteLength);
    new Uint8Array(ab).set(v);
    return { __b64: abToB64(ab) };
  }
  return v;
};

const de = (v: unknown): unknown => {
  if (v && typeof v === 'object' && '__b64' in (v as Record<string, unknown>)) {
    return b64ToAb(String((v as { __b64: string }).__b64));
  }
  return v;
};

/** Сериализует ВСЕ хранилища в один JSON-файл (строку). Ромы (ArrayBuffer) кодируются base64. */
export async function exportLibrary(): Promise<string> {
  const stores: Record<string, [string, unknown][]> = {};
  for (const s of STORES) {
    const all = await idbAll(s);
    stores[s] = all.map((e) => [e.key, ser(e.value)]);
  }
  return JSON.stringify({ app: 'retropolia-library', version: 1, exportedAt: Date.now(), stores });
}

/** Импортирует библиотеку из JSON. Возвращает число записанных объектов. Бросает исключение на чужом файле. */
export async function importLibrary(json: string): Promise<number> {
  const data = JSON.parse(json) as { app?: string; stores?: Record<string, [string, unknown][]> };
  if (!data || data.app !== 'retropolia-library' || !data.stores) {
    throw new Error('Это не файл библиотеки RETROPOLIA');
  }
  let n = 0;
  for (const s of STORES) {
    const entries = data.stores[s];
    if (!Array.isArray(entries)) continue;
    for (const [k, v] of entries) {
      await idbPut(s, k, de(v));
      n++;
    }
  }
  return n;
}

/* ---------- ЭКСПОРТ / ИМПОРТ ОДНОЙ ИГРЫ (кнопки в «Создании игры») ----------
   Игра = карта + всё, что ей нужно для партии у ДРУГА: сохранения заданий
   (уровни/боссы/моё задание) и РОМЫ (base64). Фишки/боссы/анимации/звуки/фоны
   уже вшиты В КАРТУ — отдельно не возятся. Ром нужен только на ячейки с
   заданиями: без него игра загрузится, но задания попросят ром отдельно. */

export interface ExportedGame {
  app: 'retropolia-game';
  version: 1;
  exportedAt: number;
  map: GameMap;
  saves: SaveDef[]; // сохранения заданий карты (kind: level/boss/mytask/private)
  roms: { def: RomDef; b64: string }[]; // ромы заданий карты (base64 ArrayBuffer)
}

/** Собирает ОДНУ игру в JSON-строку для передачи другу (файл .json). */
export async function exportGame(mapId: string): Promise<string> {
  const me = await idbGet<GameMap>('maps', mapId);
  if (!me) throw new Error('Карта не найдена');
  const map = JSON.parse(JSON.stringify(me)) as GameMap;
  // какие сохранения и ромы нужны заданиям карты
  const saveIds = new Set<string>();
  const romIds = new Set<string>();
  for (const c of map.cells ?? []) {
    const t = c.task;
    if (!t) continue;
    if (t.saveId) saveIds.add(t.saveId);
    if (t.romId) romIds.add(t.romId);
  }
  const saves: SaveDef[] = [];
  for (const s of await idbAll<SaveDef>('saves')) {
    if (saveIds.has(String(s.key))) saves.push(JSON.parse(JSON.stringify(s.value)));
  }
  const roms: ExportedGame['roms'] = [];
  for (const rid of romIds) {
    const rd = await idbGet<RomDef>('roms', rid);
    const blob = await idbGet<ArrayBuffer>('blobs', `rom-${rid}`);
    if (rd && blob) roms.push({ def: JSON.parse(JSON.stringify(rd)), b64: abToB64(blob) });
  }
  return JSON.stringify({ app: 'retropolia-game', version: 1, exportedAt: Date.now(), map, saves, roms } as ExportedGame);
}

/** Импортирует игру из JSON-строки. Возвращает имя карты. Коллизии id решаются
 *  новыми id с перенаправлением ссылок заданий (romId/saveId). */
export async function importGame(json: string): Promise<string> {
  const data = JSON.parse(json) as ExportedGame;
  if (!data || data.app !== 'retropolia-game' || !data.map || !Array.isArray(data.map.cells)) {
    throw new Error('Это не файл игры RETROPOLIA');
  }
  const map = JSON.parse(JSON.stringify(data.map)) as GameMap;
  const now = Date.now();
  // коллизия id карты → новая карта (можно импортировать одну игру несколько раз)
  if (await idbGet('maps', map.id)) map.id = uid('map');
  map.ready = true;
  map.updatedAt = now;
  // ромы: существующие не трогаем, новые пишем под свежими id + правим ссылки в заданиях
  const romMap: Record<string, string> = {};
  for (const r of data.roms ?? []) {
    const hasDef = !!(await idbGet('roms', r.def.id));
    const hasBlob = !!(await idbGet('blobs', `rom-${r.def.id}`));
    let rid = r.def.id;
    if (!hasDef || !hasBlob) {
      if (hasDef || hasBlob) rid = uid('rom'); // частичная коллизия — пишем как новый
      const def = { ...r.def, id: rid };
      await idbPut('roms', rid, def);
      await idbPut('blobs', `rom-${rid}`, b64ToAb(r.b64));
    }
    romMap[r.def.id] = rid;
  }
  // сохранения заданий: та же схема перенаправления + их romId → новый ром
  const saveMap: Record<string, string> = {};
  for (const s of data.saves ?? []) {
    const exists = !!(await idbGet('saves', s.id));
    let sid = s.id;
    if (!exists) {
      const def = { ...s, romId: romMap[s.romId] ?? s.romId };
      await idbPut('saves', sid, def);
    } else {
      sid = uid('save');
      await idbPut('saves', sid, { ...s, id: sid, romId: romMap[s.romId] ?? s.romId });
    }
    saveMap[s.id] = sid;
  }
  // ссылки заданий карты → новые id
  for (const c of map.cells ?? []) {
    const t = c.task;
    if (!t) continue;
    if (t.romId && romMap[t.romId]) t.romId = romMap[t.romId];
    if (t.saveId && saveMap[t.saveId]) t.saveId = saveMap[t.saveId];
  }
  await idbPut('maps', map.id, map);
  return map.name;
}
