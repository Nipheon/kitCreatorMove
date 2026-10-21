import { drawGroupFor, PadLayout, pooledCategory, poolCategoryFor } from '../padLayout';
import { Category, Sample } from '../types';
import { isUsableSample, KitOptions } from './kitGenerator';

/** Most kits one batch holds, however large the library. */
export const BATCH_MAX = 10;

/**
 * Adds a kit's samples to the used-sample history. When every usable sample of a pool
 * category has been used, that category starts a fresh round: its entries are dropped so the
 * next kit draws from all of them again. Each category rounds on its own, so closed and open
 * hats never wait on each other.
 */
export function recordKit(
  history: ReadonlySet<string>, kit: readonly (Sample | null)[], samples: readonly Sample[], options: KitOptions = {}
): Set<string> {
  const next = new Set(history);
  kit.forEach(sample => { if (sample) next.add(sample.id); });

  const byPool = new Map<Category, Sample[]>();
  for (const sample of samples) {
    if (!isUsableSample(sample, options)) continue;
    const pool = poolCategoryFor(sample);
    const list = byPool.get(pool);
    if (list) list.push(sample); else byPool.set(pool, [sample]);
  }
  byPool.forEach(list => {
    if (list.every(sample => next.has(sample.id))) list.forEach(sample => next.delete(sample.id));
  });
  return next;
}

/**
 * How many kits the library fills before every category has to reuse a sample: the kit count of
 * the most plentiful category, i.e. its usable samples divided by the unlocked pads that draw
 * from it. Perc and Other share a draw group, crashes count with percussion and generic hats
 * with closed hats. At least 1 (the kit on screen), at most `BATCH_MAX`.
 */
export function uniqueKitCount(
  samples: readonly Sample[], layout: Pick<PadLayout, 'preferences'>, lockedKit: readonly (Sample | null)[],
  options: KitOptions = {}
): number {
  const lockedIds = new Set<string>();
  lockedKit.forEach(sample => { if (sample) lockedIds.add(sample.id); });

  const groupOf = (category: Category) => drawGroupFor(pooledCategory(category)).join('+');

  const padsPerGroup = new Map<string, number>();
  layout.preferences.forEach((chain, pad) => {
    if (lockedKit[pad] || !chain[0]) return;
    const key = groupOf(chain[0]);
    padsPerGroup.set(key, (padsPerGroup.get(key) ?? 0) + 1);
  });

  const samplesPerGroup = new Map<string, number>();
  for (const sample of samples) {
    if (lockedIds.has(sample.id) || !isUsableSample(sample, options)) continue;
    const key = groupOf(sample.category);
    samplesPerGroup.set(key, (samplesPerGroup.get(key) ?? 0) + 1);
  }

  let kits = 1;
  padsPerGroup.forEach((pads, key) => {
    kits = Math.max(kits, Math.floor((samplesPerGroup.get(key) ?? 0) / pads));
  });
  return Math.min(kits, BATCH_MAX);
}
