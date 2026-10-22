import { poolCategoryFor } from '../padLayout';
import { Category, Sample } from '../types';
import { KINDS_BY_CATEGORY, SampleKind } from './kinds';
import { kindRowLabel } from './kitGenerator';
import { buildPartnerIndex } from './hatPartner';

/**
 * Layout of the sample browser as plain data: sections (a type), rows inside them (a sound kind,
 * or the hat pairs) and the samples in each row. The view only maps this onto tiles; keyboard
 * navigation walks `cells` in this order.
 */
export interface BrowserRow {
  key: string;
  label: string;
  /**
   * Samples in display order. In the `pairs` row, the samples of one hat pair follow each other
   * (closed hats first, then their open partners) and `groups` says how many belong together.
   */
  samples: Sample[];
  /** Pairs row only: size of each run of `samples` that belongs together. */
  groups?: number[];
}

export interface BrowserSection {
  key: string;
  label: string;
  rows: BrowserRow[];
}

/** Sections in the order of the breakdown card; hats join closed and open. */
const SECTIONS: { key: string; label: string; pools: Category[] }[] = [
  { key: 'kick', label: 'Kick', pools: ['Kick'] },
  { key: 'snare', label: 'Snare', pools: ['Snare'] },
  { key: 'clap', label: 'Clap', pools: ['Clap'] },
  { key: 'hats', label: 'Hats', pools: ['CHH', 'OHH'] },
  { key: 'perc', label: 'Perc', pools: ['Perc'] },
  { key: 'other', label: 'Other', pools: ['Other'] }
];

/** Kinds a section can hold, in display order (percussion lists its own kinds before the crashes it carries). */
const KIND_ORDER: Record<string, SampleKind[]> = {
  kick: [...KINDS_BY_CATEGORY.Kick],
  snare: [...KINDS_BY_CATEGORY.Snare],
  clap: [...KINDS_BY_CATEGORY.Clap],
  hats: ['closed', 'hat', 'open'],
  perc: [...KINDS_BY_CATEGORY.Perc, ...KINDS_BY_CATEGORY.Crash],
  other: [...KINDS_BY_CATEGORY.Other]
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const compareSampleNames = (a: Sample, b: Sample): number =>
  collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Closed/open hat pairs by name (`buildPartnerIndex`), found with exclusion and duplicate flags
 * ignored so a pair you disabled stays on screen to be re-enabled. One group per file-name stem:
 * its closed hats, then its open hats.
 */
export function hatPairGroups(hats: readonly Sample[]): Sample[][] {
  const byId = new Map(hats.map(s => [s.id, s]));
  const index = buildPartnerIndex(hats.map(s => ({ ...s, isExcluded: false, isDuplicate: false })));
  const groups = new Map<unknown, { closed: Sample[]; open: Sample[] }>();
  for (const [closedId, opens] of index) {
    // Every closed hat of a stem shares the one `opens` array, so it identifies the stem.
    const group = groups.get(opens) ?? { closed: [], open: opens.map(o => byId.get(o.id)!) };
    group.closed.push(byId.get(closedId)!);
    groups.set(opens, group);
  }
  return [...groups.values()]
    .map(g => [...g.closed.sort(compareSampleNames), ...g.open.sort(compareSampleNames)])
    .sort((a, b) => compareSampleNames(a[0], b[0]));
}

/**
 * The browser's layout for `samples` (the ones in visible folders). A paired hat appears only in
 * the pairs row, never again under Closed or Open, so every sample is one cell.
 */
export function buildBrowserSections(samples: readonly Sample[]): BrowserSection[] {
  const sections: BrowserSection[] = [];
  for (const { key, label, pools } of SECTIONS) {
    const inSection = samples.filter(s => pools.includes(poolCategoryFor(s)));
    if (inSection.length === 0) continue;
    const rows: BrowserRow[] = [];
    const paired = new Set<string>();

    if (key === 'hats') {
      const groups = hatPairGroups(inSection);
      if (groups.length > 0) {
        groups.flat().forEach(s => paired.add(s.id));
        rows.push({ key: 'pairs', label: 'Pairs', samples: groups.flat(), groups: groups.map(g => g.length) });
      }
    }

    for (const kind of KIND_ORDER[key]) {
      const ofKind = inSection.filter(s => s.kind === kind && !paired.has(s.id)).sort(compareSampleNames);
      if (ofKind.length > 0) rows.push({ key: kind, label: kindRowLabel(kind), samples: ofKind });
    }
    sections.push({ key, label, rows });
  }
  return sections;
}

/** Every cell in reading order, the order the cursor keys walk. */
export const browserCells = (sections: readonly BrowserSection[]): Sample[] =>
  sections.flatMap(section => section.rows.flatMap(row => row.samples));
