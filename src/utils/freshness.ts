import { drawGroupFor, PadLayout, pooledCategory, poolCategoryFor } from '../padLayout';
import { Category, Sample } from '../types';
import { isUsableSample, KitOptions } from './kitGenerator';
import { BATCH_MAX } from './storedSettings';


/**
 * Adds a kit's samples to the used-sample history. When every usable sample of a draw group
 * (a pool category; Perc and Other together) has been used, that group starts a fresh round:
 * its entries are dropped so the next kit draws from all of them again. Each group rounds on
 * its own, so closed and open hats never wait on each other.
 */
export function recordKit(
  history: ReadonlySet<string>, kit: readonly (Sample | null)[], samples: readonly Sample[], options: KitOptions = {}
): Set<string> {
  const next = new Set(history);
  kit.forEach(sample => { if (sample) next.add(sample.id); });

  // Perc and Other are drawn as one group, so they also start a new round together.
  const byGroup = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (!isUsableSample(sample, options)) continue;
    const key = drawGroupFor(poolCategoryFor(sample)).join('+');
    const list = byGroup.get(key);
    if (list) list.push(sample); else byGroup.set(key, [sample]);
  }
  byGroup.forEach(list => {
    if (list.every(sample => next.has(sample.id))) list.forEach(sample => next.delete(sample.id));
  });
  return next;
}

/**
 * How many kits the library fills before every category has to reuse a sample: the kit count of
 * the most plentiful category, i.e. its usable samples divided by the unlocked pads that draw
 * from it. Perc and Other share a draw group, crashes count with percussion and generic hats
 * with closed hats. A pad whose own role has run out of samples draws from the first role of its
 * fallback chain that still has some (else the biggest group), as the generator does, so a library
 * without snares counts those pads against the kicks. At least 1 (the kit on screen), at most
 * `BATCH_MAX`.
 */
export function uniqueKitCount(
  samples: readonly Sample[], layout: Pick<PadLayout, 'preferences'>, lockedKit: readonly (Sample | null)[],
  options: KitOptions = {}
): number {
  const lockedIds = new Set<string>();
  lockedKit.forEach(sample => { if (sample) lockedIds.add(sample.id); });

  const groupOf = (category: Category) => drawGroupFor(pooledCategory(category)).join('+');

  const samplesPerGroup = new Map<string, number>();
  for (const sample of samples) {
    if (lockedIds.has(sample.id) || !isUsableSample(sample, options)) continue;
    const key = groupOf(sample.category);
    samplesPerGroup.set(key, (samplesPerGroup.get(key) ?? 0) + 1);
  }
  if (samplesPerGroup.size === 0) return 1;

  // One kit drawn the way the generator fills it: every pad takes its own role first, then the pads left
  // empty (top row first) take the first role of their fallback chain that still has samples, else the
  // biggest group. `draws` is how many samples one kit takes from each group.
  const remaining = new Map(samplesPerGroup);
  const draws = new Map<string, number>();
  const take = (key: string) => {
    remaining.set(key, (remaining.get(key) ?? 0) - 1);
    draws.set(key, (draws.get(key) ?? 0) + 1);
  };
  const has = (key: string) => (remaining.get(key) ?? 0) > 0;

  const pending: number[] = [];
  layout.preferences.forEach((chain, pad) => {
    if (lockedKit[pad] || !chain[0]) return;
    const key = groupOf(chain[0]);
    if (has(key)) take(key); else pending.push(pad);
  });
  const rows = layout.preferences.length;
  const order = [...pending].sort((x, y) => Number(y >= rows - 4) - Number(x >= rows - 4) || x - y);
  for (const pad of order) {
    let key = layout.preferences[pad].map(groupOf).find(has);
    if (!key) {
      let most = 0;
      remaining.forEach((count, group) => { if (count > most) { most = count; key = group; } });
    }
    if (key) take(key);
  }

  let kits = 1;
  draws.forEach((count, key) => {
    kits = Math.max(kits, Math.floor((samplesPerGroup.get(key) ?? 0) / count));
  });
  return Math.min(kits, BATCH_MAX);
}
