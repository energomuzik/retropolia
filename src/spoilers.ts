/* v0.70 СПОЙЛЕРЫ: запоминание свёрнутости + общий режим из Опций.
   Режим (options.spoilerMode):
   · remember   — запоминаем состояние каждого спойлера в localStorage (по группам-ключам);
   · collapsed  — ВСЕ управляемые спойлеры показываются свёрнутыми;
   · expanded   — ВСЕ управляемые спойлеры показываются развёрнутыми.
   В режимах collapsed/expanded сохранённое состояние не трогаем: вернулись в
   «запоминать» — увидели то, что оставляли. */

export type SpoilerMode = 'remember' | 'collapsed' | 'expanded';

const SPOILERS_KEY = 'retropolia-spoilers';

type SpoilerStore = Record<string, Record<string, boolean> | boolean>;

const readStore = (): SpoilerStore => {
  try {
    const raw = localStorage.getItem(SPOILERS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? (obj as SpoilerStore) : {};
  } catch { return {}; }
};

const writeStore = (s: SpoilerStore) => {
  try { localStorage.setItem(SPOILERS_KEY, JSON.stringify(s)); } catch { /* приватный режим — переживём */ }
};

/** Рекорд спойлеров группы (например 'emuFolders' → { «NES»: true }): нет записи — пустой рекорд. */
export const loadSpoilerRec = (group: string): Record<string, boolean> => {
  const v = readStore()[group];
  return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
};

export const saveSpoilerRec = (group: string, rec: Record<string, boolean>) => {
  const s = readStore();
  s[group] = rec;
  writeStore(s);
};

/** Одиночный флаг группы (например 'taskSaves' → true). */
export const loadSpoilerFlag = (key: string): boolean | undefined => {
  const v = readStore()[key];
  return typeof v === 'boolean' ? v : undefined;
};

export const saveSpoilerFlag = (key: string, v: boolean) => {
  const s = readStore();
  s[key] = v;
  writeStore(s);
};

/** Эффективная ОТКРЫТОСТЬ спойлера: режим главнее, в «remember» — сохранённое или дефолт. */
export const effSpoilerOpen = (mode: SpoilerMode, stored: boolean | undefined, def: boolean): boolean => {
  if (mode === 'collapsed') return false;
  if (mode === 'expanded') return true;
  return stored ?? def;
};

/** Эффективная СВЁРНУТОСТЬ (для мест, где состояние хранится как «collapsed»). */
export const effSpoilerCollapsed = (mode: SpoilerMode, stored: boolean | undefined, def: boolean): boolean => {
  if (mode === 'collapsed') return true;
  if (mode === 'expanded') return false;
  return stored ?? def;
};
