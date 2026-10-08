/** The only things the app writes to localStorage: two UI settings, never samples, kits or file names. */
export const QUICK_PREVIEW_KEY = 'kitCreator.quickPreview';
export const BATCH_SIZE_KEY = 'kitCreator.batchSize';

export const BATCH_MIN = 2;
export const BATCH_MAX = 10;
export const BATCH_DEFAULT = 3;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage, or null where it is missing or throws on access (private windows, blocked site data). */
function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string, store: Store | null): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string, store: Store | null) {
  try {
    store?.setItem(key, value);
  } catch {
    // Quota or blocked storage: the setting just does not persist.
  }
}

export function loadQuickPreview(store: Store | null = defaultStore()): boolean {
  return read(QUICK_PREVIEW_KEY, store) === 'true';
}

export function saveQuickPreview(value: boolean, store: Store | null = defaultStore()) {
  write(QUICK_PREVIEW_KEY, String(value), store);
}

/** Anything that is not a whole number in range (hand-edited storage, an old build) falls back to the default. */
export function loadBatchSize(store: Store | null = defaultStore()): number {
  const raw = read(BATCH_SIZE_KEY, store);
  const n = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return n >= BATCH_MIN && n <= BATCH_MAX ? n : BATCH_DEFAULT;
}

export function saveBatchSize(value: number, store: Store | null = defaultStore()) {
  write(BATCH_SIZE_KEY, String(value), store);
}
