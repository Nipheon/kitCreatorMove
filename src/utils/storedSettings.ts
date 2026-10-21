/** The only things the app writes to localStorage: one UI setting, never samples, kits or file names. */
export const QUICK_PREVIEW_KEY = 'kitCreator.quickPreview';

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
