const DB_NAME = 'retropolia-db';
// v2: добавлено хранилище 'tokens' (фишки игроков)
const DB_VERSION = 2;
export const STORES = ['tiles', 'maps', 'roms', 'saves', 'blobs', 'sessions', 'tokens'] as const;
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
