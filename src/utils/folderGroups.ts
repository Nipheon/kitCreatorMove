import { Sample, SourceFolder } from '../types';

/** A row of the Source Folders list: a plain folder, or a collection with its sub-packs. */
export type FolderRow =
  | { kind: 'folder'; folder: SourceFolder }
  | { kind: 'collection'; id: string; name: string; children: SourceFolder[] };

/** Groups the flat folder list for display, keeping each collection where its first child sits. */
export function groupFolders(folders: readonly SourceFolder[]): FolderRow[] {
  const rows: FolderRow[] = [];
  const collections = new Map<string, Extract<FolderRow, { kind: 'collection' }>>();
  for (const folder of folders) {
    if (!folder.parent) {
      rows.push({ kind: 'folder', folder });
      continue;
    }
    let row = collections.get(folder.parent.id);
    if (!row) {
      row = { kind: 'collection', id: folder.parent.id, name: folder.parent.name, children: [] };
      collections.set(row.id, row);
      rows.push(row);
    }
    row.children.push(folder);
  }
  return rows;
}

export type TriState = 'on' | 'off' | 'mixed';

/** All sub-packs enabled, none, or some. An empty list reads as off. */
export function triState(children: readonly SourceFolder[]): TriState {
  const enabled = children.filter(f => f.isEnabled !== false).length;
  if (enabled === 0) return 'off';
  return enabled === children.length ? 'on' : 'mixed';
}

/** What a click on the collection's toggle does: a partial state is completed, like an indeterminate checkbox. */
export const enableOnToggle = (state: TriState): boolean => state !== 'on';

export interface FolderChange {
  /** The folder list after the change. */
  updated: SourceFolder[];
  /** The kit with pads whose sample is gone cleared; locked pads always stay. */
  survivors: (Sample | null)[];
  /** Folders that left the list, so the caller can revoke what the new kit no longer uses. */
  removed: SourceFolder[];
}

/**
 * Enabling or disabling any number of folders at once. Pads whose sample survives keep it,
 * so only the emptied pads are refilled by one regeneration, whether one folder changed or
 * a whole collection did.
 */
export function planToggle(
  folders: readonly SourceFolder[], ids: readonly string[], enable: boolean,
  kit: readonly (Sample | null)[], lockedPads: readonly boolean[]
): FolderChange | null {
  const targets = folders.filter(f => ids.includes(f.id));
  if (targets.length === 0) return null;
  const targetIds = new Set(targets.map(f => f.id));
  const updated = folders.map(f => (targetIds.has(f.id) ? { ...f, isEnabled: enable } : f));
  const gone = new Set(targets.flatMap(f => f.samples.map(s => s.id)));
  const survivors = kit.map((sample, idx) => {
    if (lockedPads[idx]) return sample;
    if (!enable && sample && gone.has(sample.id)) return null;
    return sample;
  });
  return { updated, survivors, removed: [] };
}

/** Removing any number of folders at once, with the same survivors rule as `planToggle`. */
export function planRemove(
  folders: readonly SourceFolder[], ids: readonly string[],
  kit: readonly (Sample | null)[], lockedPads: readonly boolean[]
): FolderChange | null {
  const removed = folders.filter(f => ids.includes(f.id));
  if (removed.length === 0) return null;
  const removedIds = new Set(removed.map(f => f.id));
  const gone = new Set(removed.flatMap(f => f.samples.map(s => s.id)));
  const survivors = kit.map((sample, idx) =>
    lockedPads[idx] || (sample && !gone.has(sample.id)) ? sample : null
  );
  return { updated: folders.filter(f => !removedIds.has(f.id)), survivors, removed };
}
