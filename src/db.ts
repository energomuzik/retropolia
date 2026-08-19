const DB_NAME = 'retropolia-db';
const DB_VERSION = 1;
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
    req.onerror = () => reject(req.error);
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
