import { FolderUp, Loader2, RefreshCw, Eye, EyeOff, HelpCircle, X, Play, Square } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pad } from './components/Pad';
import { Toast } from './components/Toast';
import {
  categoryAccent, chokeGroupFor, chooseLayout, DISPLAY_INDICES, NO_SAMPLES_GRID_ID,
  PAD_COUNT, poolCategoryFor
} from './padLayout';
import { Category, Sample, SourceFolder } from './types';
import { exportBatchKits, exportKitZip, kitSizeBytes } from './utils/exporter';
import {
  categorizeSample, getFilesFromDataTransfer, looksLikeLoop, looksNonDrum
} from './utils/fileReader';
import { emptyKit, generateRandomKit, isUsableSample, KitResult, rerollSinglePad } from './utils/kitGenerator';
import {
  DEFAULT_PREFIX, generateKitName, PREFIX_LENGTH, prefixForFolders, uniqueKitName
} from './utils/kitNaming';

/** Move copies every sample into the bundle, so a huge drop means a huge download. */
const SIZE_WARN_BYTES = 200 * 1024 * 1024;

/**
 * crypto.randomUUID is secure-context only, and `npm run dev` binds 0.0.0.0 so the
 * app is routinely opened over plain http from another machine.
 */
const newId = (label: string) =>
  globalThis.crypto?.randomUUID?.() ??
  `${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Held before pad 0 fires, on top of the buffering gate. Buffered is not the same as
 * able to make a sound immediately: the first play after the output stream has been idle
 * carries device start-up latency the readyState of a blob says nothing about. 150ms is
 * a deliberate, tuned-by-ear constant, not a measurement.
 */
const PREVIEW_LEAD_IN_MS = 150;

/** How long the warning toast stays up before dismissing itself. */
const WARNING_TOAST_MS = 5000;

const enabledSamples = (folders: SourceFolder[]) =>
  folders.filter(f => f.isEnabled !== false).flatMap(f => f.samples);

export default function App() {
  const [sourceFolders, setSourceFolders] = useState<SourceFolder[]>([]);
  const [kitResult, setKitResult] = useState<KitResult>(emptyKit);
  const [lockedPads, setLockedPads] = useState<boolean[]>(new Array(PAD_COUNT).fill(false));
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kitPrefix, setKitPrefix] = useState(DEFAULT_PREFIX);
  // Once the user types their own prefix, stop deriving it from the folder list.
  const [prefixEdited, setPrefixEdited] = useState(false);
  const [kitSuffix, setKitSuffix] = useState('KIT');
  const [batchSize, setBatchSize] = useState(1);
  const [trimSilence, setTrimSilence] = useState(true);
  const [skipLoops, setSkipLoops] = useState(true);
  const [skipNonDrums, setSkipNonDrums] = useState(true);
  /**
   * Types switched off in the breakdown card, as pool categories. A `Set` rather than
   * flags so the count of them is never a thing that can disagree with the rows.
   */
  const [disabledTypes, setDisabledTypes] = useState<ReadonlySet<Category>>(new Set());
  const [showWarning, setShowWarning] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  // Which pad to audition, and a counter so repeated shuffles of the same pad each fire.
  const [audition, setAudition] = useState<{ index: number; token: number }>({ index: -1, token: 0 });
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [autoPreview, setAutoPreview] = useState(false);
  const [spinningPads, setSpinningPads] = useState<boolean[]>(new Array(PAD_COUNT).fill(false));
  const previewTimerIds = useRef<number[]>([]);
  const spinTimerIds = useRef<number[]>([]);
  const lastStoppedTime = useRef(0);
  /** Pad index -> id of the sample that pad has finished buffering. */
  const readyPads = useRef(new Map<number, string>());
  /**
   * Names written into a bundle this session. Only a real export lands here: generating
   * a kit and rolling past it must never make a later kit collide with a phantom.
   */
  const exportedNames = useRef(new Set<string>());
  /** Removes the in-flight `pad-ready` gate listener, if a preview is waiting on one. */
  const readyWaitCleanup = useRef<(() => void) | null>(null);

  // Mounted for the app's lifetime: pads buffer long before any preview is requested,
  // so the registry has to be listening before startPreview is ever called.
  useEffect(() => {
    const onPadReady = (e: Event) => {
      const { index, sampleId } = (e as CustomEvent<{ index: number; sampleId: string }>).detail;
      readyPads.current.set(index, sampleId);
    };
    window.addEventListener('pad-ready', onPadReady);
    return () => window.removeEventListener('pad-ready', onPadReady);
  }, []);

  const dismissWarning = React.useCallback(() => setShowWarning(false), []);

  const stopSpinAnimation = React.useCallback(() => {
    spinTimerIds.current.forEach(id => clearTimeout(id));
    spinTimerIds.current = [];
    setSpinningPads(new Array(PAD_COUNT).fill(false));
  }, []);

  const stopPreview = React.useCallback(() => {
    lastStoppedTime.current = Date.now();
    previewTimerIds.current.forEach(id => clearTimeout(id));
    previewTimerIds.current = [];
    readyWaitCleanup.current?.();
    readyWaitCleanup.current = null;
    setIsPreviewing(false);
    window.dispatchEvent(new CustomEvent('stop-all-audio'));
  }, []);

  /**
   * Takes the kit to preview as an argument rather than reading `kit` state: a generate
   * calls setKitResult and startPreview in the same tick, so the state read here would
   * still be the previous kit.
   */
  const startPreview = React.useCallback((kitToPreview: (Sample | null)[]) => {
    stopPreview();
    setIsPreviewing(true);

    const padOrder = Array.from({ length: PAD_COUNT }, (_, i) => i);
    let currentStep = 0;

    const playNextStep = () => {
      if (currentStep >= padOrder.length) {
        setIsPreviewing(false);
        return;
      }

      const padIndex = padOrder[currentStep];
      currentStep++;

      let stepAdvanced = false;

      const advanceStep = () => {
        if (stepAdvanced) return;
        stepAdvanced = true;

        if (currentStep < padOrder.length) {
          const timerId = window.setTimeout(playNextStep, 750);
          previewTimerIds.current.push(timerId);
        } else {
          const endTimerId = window.setTimeout(() => {
            setIsPreviewing(false);
          }, 750);
          previewTimerIds.current.push(endTimerId);
        }
      };

      const onPadStarted = (e: Event) => {
        if ((e as CustomEvent<number>).detail === padIndex) {
          window.removeEventListener('pad-started', onPadStarted);
          advanceStep();
        }
      };

      window.addEventListener('pad-started', onPadStarted);

      // Fallback timer in case pad is empty or audio playback fails/errors
      const fallbackTimerId = window.setTimeout(() => {
        window.removeEventListener('pad-started', onPadStarted);
        advanceStep();
      }, 1000);
      previewTimerIds.current.push(fallbackTimerId);

      window.dispatchEvent(new CustomEvent('play-pad', { detail: padIndex }));
    };

    /**
     * Pad 01 used to fire on a flat 100ms tick while every later pad got 750ms+ of extra
     * buffering, so on a cold generate only pad 01 was told to play while still decoding.
     * This gate holds the sequence until every pad reports buffered — necessary, but it
     * was not sufficient on its own: pad 01 still sounded late with the gate alone, which
     * is why the lead-in below and the onset-accurate `pad-started` in Pad exist.
     */
    const isReady = (sample: Sample | null, index: number) =>
      !sample || readyPads.current.get(index) === sample.id;

    /**
     * The lead-in is keyed on whether the audio was cold, not on who asked. Keying it on
     * auto-vs-manual gave manual preview a 0ms start even when it had just waited on the
     * gate — pressing Preview Kit straight after a generate put pad 01 back exactly where
     * this whole fix started. Pads already buffered need no lead-in whoever asked, and
     * auto preview always arrives cold, so its behaviour is unchanged in practice.
     */
    const startSequence = (waitedForBuffering: boolean) => {
      const leadInMs = waitedForBuffering ? PREVIEW_LEAD_IN_MS : 0;
      const leadInTimerId = window.setTimeout(playNextStep, leadInMs);
      previewTimerIds.current.push(leadInTimerId);
    };

    if (kitToPreview.every(isReady)) {
      startSequence(false);
      return;
    }

    const beginWhenReady = () => {
      if (!kitToPreview.every(isReady)) return;
      readyWaitCleanup.current?.();
      readyWaitCleanup.current = null;
      startSequence(true);
    };

    window.addEventListener('pad-ready', beginWhenReady);
    // Ceiling so a sample that never decodes cannot leave the preview hanging.
    const ceilingTimerId = window.setTimeout(() => {
      readyWaitCleanup.current?.();
      readyWaitCleanup.current = null;
      startSequence(true);
    }, 2000);
    previewTimerIds.current.push(ceilingTimerId);

    readyWaitCleanup.current = () => {
      window.removeEventListener('pad-ready', beginWhenReady);
      clearTimeout(ceilingTimerId);
    };
  }, [stopPreview]);

  const previewKit = React.useCallback(() => {
    if (isPreviewing || Date.now() - lastStoppedTime.current < 200) {
      stopPreview();
      return;
    }

    startPreview(kitResult.kit);
  }, [isPreviewing, stopPreview, startPreview, kitResult.kit]);

  useEffect(() => {
    if (!isPreviewing) return;

    const handleGlobalInteraction = () => {
      stopPreview();
    };

    window.addEventListener('pointerdown', handleGlobalInteraction, true);
    window.addEventListener('keydown', handleGlobalInteraction, true);
    return () => {
      window.removeEventListener('pointerdown', handleGlobalInteraction, true);
      window.removeEventListener('keydown', handleGlobalInteraction, true);
    };
  }, [isPreviewing, stopPreview]);

  useEffect(() => {
    return () => stopPreview();
  }, [stopPreview]);

  // dragenter/dragleave also fire for every child element, so the overlay is driven
  // by a depth counter rather than by the raw events.
  const dragDepth = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  const samples = useMemo(() => enabledSamples(sourceFolders), [sourceFolders]);
  const kit = kitResult.kit;

  /**
   * The only place the warning toast is timed. `Toast` is presentational: it ran a
   * second 5s timer of its own, which never reliably fired because its `onClose` prop
   * is a fresh closure each render and sat in the effect's dependency list.
   */
  useEffect(() => {
    if (kitResult.substituted.length > 0 || kitResult.empty.length > 0 || kitResult.unavailableRoles.length > 0) {
      setShowWarning(true);
      const timer = setTimeout(() => setShowWarning(false), WARNING_TOAST_MS);
      return () => clearTimeout(timer);
    } else {
      setShowWarning(false);
    }
  }, [kitResult]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const KEY_TO_PAD: Record<string, number> = {
        '1': 12, '2': 13, '3': 14, '4': 15,
        'q': 8, 'w': 9, 'e': 10, 'r': 11,
        'a': 4, 's': 5, 'd': 6, 'f': 7,
        'y': 0, 'z': 0, 'x': 1, 'c': 2, 'v': 3
      };

      const key = e.key.toLowerCase();
      const padIndex = KEY_TO_PAD[key];

      if (padIndex !== undefined) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('play-pad', { detail: padIndex }));
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const kitOptions = { skipLoops, skipNonDrums, disabledTypes };

  /**
   * The grid id travels in the exported kit name so a rack can be identified on the
   * device. `columnsId` rather than `id`: Move shows roughly 9-11 characters, and
   * `PRE-ksho-Suffix` keeps both identifying parts ahead of the cut while the full id
   * would not fit. The id is dropped entirely while no samples are loaded.
   */
  const kitNameFor = (suffix: string, gridId: string) =>
    gridId && gridId !== NO_SAMPLES_GRID_ID
      ? `${kitPrefix}-${gridId}-${suffix}`
      : `${kitPrefix}-${suffix}`;

  const exportName = kitNameFor(kitSuffix, kitResult.layout.columnsId);
  const loopCount = useMemo(() => samples.filter(s => s.isLoop).length, [samples]);
  const nonDrumCount = useMemo(() => samples.filter(s => s.isNonDrum && !s.isLoop).length, [samples]);
  const activeFoldersCount = useMemo(
    () => sourceFolders.filter(f => f.isEnabled !== false).length,
    [sourceFolders]
  );
  const usableCount = useMemo(
    () => samples.filter(s => isUsableSample(s, kitOptions)).length,
    [samples, skipLoops, skipNonDrums, disabledTypes]
  );
  const categoryStats = useMemo(() => {
    const stats: Record<Category, { usable: number; total: number }> = {
      Kick: { usable: 0, total: 0 },
      Snare: { usable: 0, total: 0 },
      Clap: { usable: 0, total: 0 },
      CHH: { usable: 0, total: 0 },
      OHH: { usable: 0, total: 0 },
      Hat: { usable: 0, total: 0 },
      Crash: { usable: 0, total: 0 },
      Perc: { usable: 0, total: 0 },
      Other: { usable: 0, total: 0 }
    };
    samples.forEach(s => {
      // Counted under the pool the sample is actually drawn from: generic hats are
      // closed hats and crashes are percussion, so rows for them would read as unused
      // while their samples sit on CHH and Perc pads.
      const row = poolCategoryFor(s);
      stats[row].total += 1;
      if (isUsableSample(s, kitOptions)) {
        stats[row].usable += 1;
      }
    });
    return stats;
  }, [samples, skipLoops, skipNonDrums, disabledTypes]);

  const BREAKDOWN_ROWS: Category[] = ['Kick', 'Snare', 'Clap', 'CHH', 'OHH', 'Perc', 'Other'];
  const BREAKDOWN_LABELS: Partial<Record<Category, string>> = {
    CHH: 'CHH + HAT',
    Perc: 'PERC + CRASH'
  };

  /**
   * Keeps the preset prefix in step with the folder that is actually loaded. Removing
   * or disabling the folder the name came from used to leave its name behind, so a kit
   * built entirely from "BBBB" still exported as "AAAA-…".
   */
  const syncPrefix = (folders: SourceFolder[]) => {
    if (!prefixEdited) setKitPrefix(prefixForFolders(folders));
  };

  const lockedFrom = (current: (Sample | null)[]) =>
    lockedPads.map((locked, idx) => (locked ? current[idx] : null));

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };

  const processFiles = async (items: DataTransferItemList) => {
    setIsLoading(true);
    setError(null);

    try {
      const folderData = await getFilesFromDataTransfer(items);
      const newFolders: SourceFolder[] = [];
      const existingFolderNames = new Set(sourceFolders.map(f => f.name.toLowerCase()));

      let skippedDuplicates = 0;

      for (const folder of folderData) {
        const folderName = folder.name || 'Dropped Files';
        if (existingFolderNames.has(folderName.toLowerCase())) {
          skippedDuplicates++;
          continue;
        }

        const samples: Sample[] = [];
        for (const { file, path } of folder.files) {
          const url = URL.createObjectURL(file);

          const category = categorizeSample(file.name, path);

          samples.push({
            id: newId('sample'),
            file,
            name: file.name,
            category,
            // The category is passed so the break rule can stay off anything the
            // categoriser placed — a snare named "Break Snare" is still a snare.
            isLoop: looksLikeLoop(file.name, path, category),
            isNonDrum: looksNonDrum(category, file.name, path),
            url
          });
        }

        if (samples.length > 0) {
          newFolders.push({
            id: newId('folder'),
            name: folderName,
            isEnabled: true,
            samples
          });
          existingFolderNames.add(folderName.toLowerCase());
        }
      }

      if (newFolders.length === 0) {
        // A drop that changes nothing has to say why, or it reads as the app ignoring you.
        setError(
          skippedDuplicates > 0
            ? skippedDuplicates === 1
              ? 'That folder is already loaded.'
              : `Those ${skippedDuplicates} folders are already loaded.`
            : 'No .wav or .aiff files found in what you dropped. Move plays those two formats only.'
        );
        return;
      }

      // Computed outside the state updater: updaters must stay pure, and StrictMode
      // double-invokes them.
      const wasEmpty = sourceFolders.length === 0;
      const updated = [...sourceFolders, ...newFolders];
      const allSamples = enabledSamples(updated);

      setSourceFolders(updated);
      if (allSamples.length > 0) {
        setKitResult(generateRandomKit(allSamples, lockedFrom(kit), kitOptions));
      }
      syncPrefix(updated);
      // The suffix is only rolled for the first drop; after that it is the user's,
      // changed by the Randomize Suffix button.
      if (wasEmpty) setKitSuffix(generateKitName(newFolders[0].name).suffix);
    } catch (err) {
      console.error('Failed to process files:', err);
      setError('Error processing files. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Deliberately not memoised: a stale closure here would make every drop after the
  // first build its kit from that folder alone and ignore locked pads.
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    if (isLoading) return; // two overlapping scans would both capture the same state
    if (e.dataTransfer.items) processFiles(e.dataTransfer.items);
  };

  const removeFolder = (id: string) => {
    const removed = sourceFolders.find(f => f.id === id);
    const updated = sourceFolders.filter(f => f.id !== id);
    const remaining = enabledSamples(updated);
    const removedIds = new Set(removed?.samples.map(s => s.id) ?? []);

    // Keep every pad whose sample survived; only the emptied ones get refilled.
    const survivors = kit.map((sample, idx) =>
      lockedPads[idx] || (sample && !removedIds.has(sample.id)) ? sample : null
    );

    const next: KitResult = remaining.length > 0
      ? generateRandomKit(remaining, survivors, kitOptions)
      : {
        kit: survivors.map((s, idx) => (lockedPads[idx] ? s : null)),
        layout: chooseLayout(remaining),
        substituted: [],
        empty: [],
        unavailableRoles: []
      };

    setSourceFolders(updated);
    setKitResult(next);
    syncPrefix(updated);

    // Revoked here rather than in an effect cleanup: StrictMode's double-mount would
    // run an unmount cleanup immediately and break every preview. A locked pad keeps
    // its sample even when its folder is removed, so only revoke what the new kit
    // no longer references — otherwise that pad's preview goes silently dead.
    const stillUsed = new Set(next.kit.filter((s): s is Sample => s !== null).map(s => s.id));
    removed?.samples.forEach(s => {
      if (!stillUsed.has(s.id)) URL.revokeObjectURL(s.url);
    });
  };

  const toggleFolder = (id: string) => {
    const target = sourceFolders.find(f => f.id === id);
    if (!target) return;
    const willDisable = target.isEnabled !== false;
    const updated = sourceFolders.map(f => (f.id === id ? { ...f, isEnabled: !willDisable } : f));
    const remaining = enabledSamples(updated);
    const targetIds = new Set(target.samples.map(s => s.id));

    const survivors = kit.map((sample, idx) => {
      if (lockedPads[idx]) return sample;
      if (willDisable && sample && targetIds.has(sample.id)) return null;
      return sample;
    });

    setSourceFolders(updated);
    setKitResult(
      remaining.length > 0
        ? generateRandomKit(remaining, survivors, kitOptions)
        : {
          kit: survivors.map((s, idx) => (lockedPads[idx] ? s : null)),
          layout: chooseLayout(remaining),
          substituted: [],
          empty: [],
          unavailableRoles: []
        }
    );
    syncPrefix(updated);
  };

  const handleExcludeSample = (sampleId: string, padIndex?: number) => {
    const updated = sourceFolders.map(f => ({
      ...f,
      samples: f.samples.map(s => (s.id === sampleId ? { ...s, isExcluded: true } : s))
    }));
    const remaining = enabledSamples(updated);
    const survivors = kit.map(sample => (sample?.id !== sampleId ? sample : null));

    setSourceFolders(updated);
    setKitResult(
      remaining.length > 0
        ? generateRandomKit(remaining, survivors, kitOptions)
        : { kit: survivors, layout: chooseLayout(remaining), substituted: [], empty: [], unavailableRoles: [] }
    );
    if (padIndex !== undefined) {
      setAudition(prev => ({ index: padIndex, token: prev.token + 1 }));
    }
  };

  const randomizeKit = () => {
    stopPreview();
    stopSpinAnimation();

    if (samples.length > 0) {
      const next = generateRandomKit(samples, lockedFrom(kit), kitOptions);
      setKitResult(next);

      if (autoPreview) {
        startPreview(next.kit);
      } else {
        // All pads start spinning simultaneously
        setSpinningPads(new Array(PAD_COUNT).fill(true));

        // Each pad gets a random duration up to 100ms
        for (let i = 0; i < PAD_COUNT; i++) {
          const duration = Math.floor(Math.random() * 70) + 30; // 30ms - 100ms
          const timerId = window.setTimeout(() => {
            setSpinningPads(prev => {
              const next = [...prev];
              next[i] = false;
              return next;
            });
          }, duration);
          spinTimerIds.current.push(timerId);
        }
      }
    }
  };

  const rerollPad = (index: number) => {
    if (samples.length > 0 && !lockedPads[index]) {
      setKitResult(rerollSinglePad(samples, kit, index, kitOptions));
      setAudition(prev => ({ index, token: prev.token + 1 }));
    }
  };

  // Regenerates immediately, otherwise the toggle looks inert.
  const toggleSkipLoops = (next: boolean) => {
    setSkipLoops(next);
    if (samples.length > 0) {
      setKitResult(generateRandomKit(samples, lockedFrom(kit), { ...kitOptions, skipLoops: next }));
    }
  };

  const toggleSkipNonDrums = (next: boolean) => {
    setSkipNonDrums(next);
    if (samples.length > 0) {
      setKitResult(
        generateRandomKit(samples, lockedFrom(kit), { ...kitOptions, skipNonDrums: next })
      );
    }
  };

  /**
   * Switches a whole type off. Regenerates immediately for the same reason the other
   * filters do — a toggle that changes nothing visible reads as broken — and the new set
   * is passed explicitly rather than read back from state, which would still hold the old
   * one this tick.
   */
  const toggleType = (category: Category) => {
    const next = new Set(disabledTypes);
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    setDisabledTypes(next);
    if (samples.length > 0) {
      setKitResult(generateRandomKit(samples, lockedFrom(kit), { ...kitOptions, disabledTypes: next }));
    }
  };

  const toggleLock = (index: number) => {
    setLockedPads(prev => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  };

  /**
   * How many fresh suffixes to try before numbering. The pool is ~39 words, so a clash
   * is unlucky rather than likely; rolling again reads better than `-2` and costs
   * nothing, but the loop has to terminate once the pool is genuinely exhausted.
   */
  const SUFFIX_ATTEMPTS = 8;

  const buildBatch = () => {
    // Seeded from what has actually been exported, so a kit generated and discarded
    // never pushes a number onto a later name.
    const taken = new Set(exportedNames.current);
    const kits: { kit: (Sample | null)[]; name: string }[] = [];

    const first = uniqueKitName(exportName, taken);
    taken.add(first);
    kits.push({ kit: [...kit], name: first });

    for (let i = 1; i < batchSize; i++) {
      const next = generateRandomKit(samples, lockedFrom(kit), kitOptions);
      // Every kit in a batch is built from the same library, so they all share a grid
      // and the id is the same for each — which is the point: a batch is swappable.
      let name = '';
      for (let attempt = 0; attempt < SUFFIX_ATTEMPTS && !name; attempt++) {
        const candidate = kitNameFor(generateKitName('').suffix, next.layout.columnsId);
        if (!taken.has(candidate)) name = candidate;
      }
      if (!name) {
        name = uniqueKitName(kitNameFor(generateKitName('').suffix, next.layout.columnsId), taken);
      }
      taken.add(name);
      kits.push({ kit: next.kit, name });
    }
    return kits;
  };

  const exportKit = async () => {
    if (kit.every(s => s === null)) return;

    const bytes = kitSizeBytes(kit) * batchSize;
    if (bytes > SIZE_WARN_BYTES) {
      const proceed = window.confirm(
        `This export is roughly ${formatMb(bytes)} of audio. Bundles are built in memory and may fail at this size. Continue?`
      );
      if (!proceed) return;
    }

    setIsExporting(true);
    setError(null);
    setNotice(null);
    const onProgress = (done: number, total: number) => setExportProgress({ done, total });

    try {
      const names: string[] = [];
      let report;
      if (batchSize > 1) {
        const batch = buildBatch();
        names.push(...batch.map(entry => entry.name));
        report = await exportBatchKits(batch, kitPrefix, { trimSilence, onProgress });
      } else {
        const single = uniqueKitName(exportName, exportedNames.current);
        names.push(single);
        report = await exportKitZip(kit, single, { trimSilence, onProgress });
        if (single !== exportName) {
          setNotice(`"${exportName}" was already exported this session, so this kit was saved as "${single}".`);
        }
      }
      // Recorded only after the export resolved: a failed one wrote no file, so its
      // names are still free.
      names.forEach(name => exportedNames.current.add(name));

      if (report.trimFailures > 0) {
        setNotice(`${report.trimFailures} sample(s) could not be trimmed and were exported unchanged.`);
      }
    } catch (err) {
      console.error('Export failed:', err);
      setError('Export failed. Try a smaller batch or fewer samples.');
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  };

  const isEmpty = kit.every(s => s === null);
  const filledPads = kit.filter(Boolean).length;

  return (
    <div
      className="flex flex-col h-screen w-screen bg-surface-darkest text-text-bright font-sans overflow-hidden"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {(isDragging || isLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-darkest/90 backdrop-blur-sm border-2 border-dashed border-accent-yellow m-4 rounded-xl">
          <div className="text-center">
            {isLoading ? (
              <>
                <Loader2 className="w-16 h-16 text-accent-yellow mx-auto mb-4 animate-spin" />
                <h2 className="text-2xl font-bold uppercase tracking-widest">Scanning</h2>
                <p className="text-text-muted mt-2 text-sm uppercase tracking-wider">Reading audio files…</p>
              </>
            ) : (
              <>
                <FolderUp className="w-16 h-16 text-accent-yellow mx-auto mb-4 animate-pulse" />
                <h2 className="text-2xl font-bold uppercase tracking-widest">Drop Sample Folders Here</h2>
                <p className="text-text-muted mt-2 text-sm uppercase tracking-wider">.wav and .aiff files</p>
              </>
            )}
          </div>
        </div>
      )}

      <header className='header-gradient flex items-center justify-between px-8 py-4 border-b border-border-dark shrink-0'>
        <div className='flex items-center gap-3'>
          {/* Decoration beside a heading that already names the app, so it carries an
              empty alt rather than a description. Same file as the favicon — width and
              height are set to stop the header shifting while it loads. */}
          <img
            src='/icon.png'
            alt=''
            width={32}
            height={32}
            className='w-8 h-8 shrink-0'
          />
          <h1 className='text-lg font-bold tracking-widest uppercase'>Kit Creator for Ableton Move</h1>
        </div>
        <div className='flex items-center gap-4'>
          <div className='hidden sm:block text-sm text-text-subtle uppercase tracking-wider'>
            Exports an .ablpresetbundle — copy it to your Move
          </div>
          <button
            onClick={() => setIsHelpOpen(true)}
            className='flex items-center gap-1.5 px-3 py-1.5 bg-surface-pad hover:bg-surface-btn-hover border border-border-main hover:border-accent-yellow text-text-light hover:text-accent-yellow rounded text-sm font-semibold uppercase tracking-wider transition-all cursor-pointer'
            title='Open User Manual & Help'
            aria-label='Open User Manual'
          >
            <HelpCircle size={16} />
            <span>Help</span>
          </button>
        </div>
      </header>

      <main className='flex flex-col lg:flex-row flex-1 overflow-y-auto lg:overflow-hidden'>
        <aside className='w-full lg:w-72 bg-surface-panel border-b lg:border-b-0 lg:border-r border-border-dark p-6 flex flex-col shrink-0 lg:overflow-y-auto'>
          <div className='mb-8'>
            <h2 className='text-sm uppercase tracking-[0.2em] font-semibold text-text-subtle mb-4'>Source Folders</h2>
            <div className='border-2 border-dashed border-border-main rounded-lg p-4 text-center mb-4'>
              <div className='text-2xl mb-2 text-text-dim'>+</div>
              <p className='text-sm text-text-muted'>Drag sample folders anywhere on this window</p>
            </div>
            {sourceFolders.map(folder => (
              <div key={folder.id} className={`space-y-2 mt-2 ${folder.isEnabled === false ? 'opacity-50' : ''}`}>
                <div className='bg-surface-pad px-3 py-2 rounded flex items-center justify-between group'>
                  <div className='flex items-center gap-2 overflow-hidden flex-1'>
                    <button
                      onClick={() => toggleFolder(folder.id)}
                      className='text-text-muted-dark hover:text-text-bright transition-colors shrink-0'
                      title={folder.isEnabled === false ? 'Enable folder' : 'Disable folder'}
                      aria-label={folder.isEnabled === false ? `Enable ${folder.name}` : `Disable ${folder.name}`}
                    >
                      {folder.isEnabled === false ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                    <span className='text-sm truncate text-text-bright flex-1'>{folder.name}</span>
                    <span className='text-sm text-text-muted shrink-0 font-medium bg-surface-header px-2 py-0.5 rounded'>{folder.samples.length}</span>
                  </div>
                  <button
                    onClick={() => removeFolder(folder.id)}
                    className='text-sm font-bold text-text-muted-dark group-hover:text-danger-text ml-2'
                    aria-label={`Remove ${folder.name}`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            {sourceFolders.length === 0 && (
              <div className='text-sm text-text-subtle text-center mt-4'>No folders loaded</div>
            )}
          </div>
          <div className='mt-auto space-y-2'>
            <div className='text-xs text-text-muted uppercase tracking-wider font-medium px-1'>
              {sourceFolders.length > 0 ? `${activeFoldersCount} folder(s) used` : 'Waiting for samples'}
            </div>
            <div className='p-4 bg-surface-card rounded-lg border border-border-dark space-y-3'>
              <div>
                <div className='flex justify-between text-sm mb-2 text-text-muted uppercase font-medium'>
                  <span>Usable Samples</span>
                  <span>{usableCount.toLocaleString()} / {samples.length.toLocaleString()}</span>
                </div>
                <div className='w-full bg-border-main h-1.5 rounded-full overflow-hidden'>
                  <div className='bg-accent-teal h-full transition-all' style={{ width: samples.length > 0 ? `${Math.round((usableCount / samples.length) * 100)}%` : '0%' }}></div>
                </div>
              </div>

              {samples.length > 0 && (
                <div className='pt-3 border-t border-border-dark space-y-1.5'>
                  <div className='text-xs text-text-muted uppercase tracking-wider font-medium mb-2'>
                    Breakdown by Type
                  </div>
                  <div className='flex flex-col space-y-1.5'>
                    {BREAKDOWN_ROWS.map(cat => {
                      const { usable, total } = categoryStats[cat];
                      const label = BREAKDOWN_LABELS[cat] ?? cat;
                      const isOff = disabledTypes.has(cat);
                      return (
                        <div
                          key={cat}
                          // The same custom property the pads set, so a row and the pads
                          // it feeds are the one colour rather than two lists to keep in
                          // step. CHH carries generic hats and Perc carries crashes here
                          // exactly as they do on a pad, because both read the pool.
                          style={{ '--category-accent': categoryAccent(cat) } as React.CSSProperties}
                          className={`flex justify-between items-center gap-2 text-sm uppercase font-medium ${isOff ? 'opacity-50' : ''}`}
                          title={cat === 'CHH'
                            ? 'Hats with no open/closed qualifier are treated as closed hats'
                            : cat === 'Perc'
                              ? 'Crashes are drawn from the percussion pool'
                              : undefined}
                        >
                          <div className='flex items-center gap-2 min-w-0'>
                            <button
                              type='button'
                              onClick={() => toggleType(cat)}
                              disabled={total === 0}
                              aria-pressed={isOff}
                              className='text-text-subtle hover:text-text-bright transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer'
                              title={isOff ? `Use ${label} samples again` : `Leave ${label} samples out of every kit`}
                              aria-label={isOff ? `Enable ${label}` : `Disable ${label}`}
                            >
                              {isOff ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                            {/* Tinted only when the row has samples: a type the library
                                does not hold should read as absent, not as available. */}
                            <span className={`truncate ${total > 0 ? 'category-ink' : 'text-text-muted-dark opacity-50'}`}>
                              {label}
                            </span>
                          </div>
                          <span className={`shrink-0 ${usable > 0 ? 'text-text-bright' : 'text-text-muted-dark opacity-50'}`}>
                            {usable.toLocaleString()} / {total.toLocaleString()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>

        <section className='flex-1 w-full bg-surface-darkest flex flex-col items-center justify-center p-4 sm:p-8 overflow-y-auto min-h-0'>
          <div className='grid grid-cols-4 gap-3 sm:gap-4 mb-8 w-full max-w-[700px] aspect-square'>
            {DISPLAY_INDICES.map((index) => (
              <Pad
                key={index}
                index={index}
                sample={kit[index]}
                expectedCategory={kitResult.layout.roles[index]}
                chokeGroup={chokeGroupFor(kit[index])}
                isLocked={lockedPads[index]}
                onToggleLock={() => toggleLock(index)}
                onExclude={handleExcludeSample}
                onReroll={rerollPad}
                auditionToken={audition.index === index ? audition.token : 0}
                isSpinning={spinningPads[index]}
              />
            ))}
          </div>

          <Toast
            isVisible={showWarning}
            unavailableRoles={kitResult.unavailableRoles}
            substitutedCount={kitResult.substituted.length}
            emptyCount={kitResult.empty.length}
            onClose={dismissWarning}
          />

          <div className='flex items-center gap-3 sm:gap-4 flex-wrap justify-center'>
            <button
              onClick={randomizeKit}
              className='px-8 py-3 bg-accent-yellow text-text-inverse font-bold uppercase text-sm tracking-widest rounded-full hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_24px_var(--accent-yellow-glow)] cursor-pointer'
              disabled={usableCount === 0}
            >
              Generate Random Kit
            </button>
            <div className='flex items-center gap-3'>
              <button
                onClick={previewKit}
                disabled={isEmpty}
                className='px-6 py-3 bg-surface-pad border border-border-main hover:border-accent-teal text-text-bright hover:text-accent-teal font-bold uppercase text-sm tracking-widest rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2'
                title={isPreviewing ? 'Stop preview' : 'Preview each pad in sequence'}
                aria-label={isPreviewing ? 'Stop previewing kit' : 'Preview kit'}
              >
                {isPreviewing ? <Square size={14} className='fill-current' /> : <Play size={14} className='fill-current' />}
                <span>{isPreviewing ? 'Stop Preview' : 'Preview Kit'}</span>
              </button>
              <label className='flex items-center gap-2 text-sm text-text-muted hover:text-text-bright uppercase tracking-wider cursor-pointer select-none'>
                <input
                  type='checkbox'
                  checked={autoPreview}
                  onChange={(e) => setAutoPreview(e.target.checked)}
                  className='accent-accent-teal w-4 h-4 cursor-pointer'
                />
                Auto Preview
              </label>
            </div>
          </div>
        </section>

        <aside className='w-full lg:w-80 bg-surface-panel border-t lg:border-t-0 lg:border-l border-border-dark p-6 flex flex-col shrink-0 lg:overflow-y-auto'>
          <h2 className='text-sm uppercase tracking-[0.2em] font-semibold text-text-subtle mb-6'>Preset Settings</h2>
          <div className='space-y-6'>
            <div className='space-y-2'>
              <div className='flex justify-between items-center'>
                <label className='text-sm text-text-muted uppercase'>Preset Name</label>
                <button
                  onClick={() => setKitSuffix(generateKitName('').suffix)}
                  className='text-sm text-accent-yellow hover:brightness-125 transition-all flex items-center gap-1 cursor-pointer'
                >
                  <RefreshCw size={14} /> Randomize Suffix
                </button>
              </div>
              <div className='flex gap-2 items-center'>
                <input
                  type='text'
                  value={kitPrefix}
                  onChange={(e) => {
                    setKitPrefix(e.target.value);
                    setPrefixEdited(true);
                  }}
                  className='w-1/2 bg-surface-pad border border-border-main rounded px-3 py-2 text-sm focus:border-accent-yellow outline-none text-text-bright uppercase'
                  placeholder='PRE'
                  maxLength={PREFIX_LENGTH}
                  aria-label='Preset name prefix'
                />
                <span className='text-text-muted-dark'>-</span>
                <input
                  type='text'
                  value={kitSuffix}
                  onChange={(e) => setKitSuffix(e.target.value)}
                  className='w-1/2 bg-surface-pad border border-border-main rounded px-3 py-2 text-sm focus:border-accent-yellow outline-none text-text-bright'
                  placeholder='SUFFIX'
                  maxLength={12}
                  aria-label='Preset name suffix'
                />
              </div>
              <div className='text-sm text-text-subtle font-mono truncate' title={exportName}>
                {exportName}
              </div>
            </div>

            <div className='space-y-2'>
              <div className='flex justify-between items-center'>
                <label htmlFor='batch-size' className='text-sm text-text-muted uppercase'>Batch Export Amount</label>
                <span className='text-sm text-accent-yellow font-bold'>{batchSize} Kit{batchSize !== 1 ? 's' : ''}</span>
              </div>
              <input
                id='batch-size'
                type='range'
                min='1'
                max='10'
                value={batchSize}
                onChange={(e) => setBatchSize(parseInt(e.target.value))}
                className='w-full accent-accent-yellow'
              />
              <p className='text-sm leading-snug text-text-subtle'>
                Export multiple random kits in one zip. Locked pads remain the same across all.
              </p>
            </div>

            {/* Directly under the slider it belongs to: the batch size decides what this
                button produces, and reading the count then hunting for the action at the
                far end of the panel put them out of sight of each other. */}
            <div>
              {isExporting && exportProgress && exportProgress.total > 1 && (
                <div className='text-sm text-text-muted uppercase tracking-wider mb-2 text-center'>
                  Kit {Math.min(exportProgress.done + 1, exportProgress.total)} of {exportProgress.total}
                </div>
              )}
              <button
                onClick={exportKit}
                disabled={isEmpty || isExporting}
                className='w-full py-3.5 bg-surface-solid text-text-inverse font-bold uppercase text-sm tracking-[0.2em] rounded flex items-center justify-center gap-2 hover:bg-surface-solid-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer'
              >
                {isExporting && <Loader2 className='w-4 h-4 animate-spin' />}
                {isExporting ? 'Building Bundle…' : 'Export To Move'}
              </button>
            </div>

            <div>
              <label className='flex items-center gap-2 text-sm text-text-muted uppercase cursor-pointer'>
                <input
                  type='checkbox'
                  checked={skipLoops}
                  onChange={(e) => toggleSkipLoops(e.target.checked)}
                  className='accent-accent-yellow w-4 h-4'
                />
                Skip loops{loopCount > 0 ? ` (${loopCount} found)` : ''}
              </label>
            </div>

            <div>
              <label className='flex items-center gap-2 text-sm text-text-muted uppercase cursor-pointer'>
                <input
                  type='checkbox'
                  checked={skipNonDrums}
                  onChange={(e) => toggleSkipNonDrums(e.target.checked)}
                  className='accent-accent-yellow w-4 h-4'
                />
                Skip non-drums{nonDrumCount > 0 ? ` (${nonDrumCount} found)` : ''}
              </label>
            </div>

            <div>
              <label className='flex items-center gap-2 text-sm text-text-muted uppercase cursor-pointer'>
                <input
                  type='checkbox'
                  checked={trimSilence}
                  onChange={(e) => setTrimSilence(e.target.checked)}
                  className='accent-accent-yellow w-4 h-4'
                />
                Trim silence (start & end)
              </label>
              <p className='text-sm leading-snug text-text-subtle'>
                Applied on export only — pads always audition the original file.
              </p>
            </div>

            <div className='pt-6 border-t border-border-dark space-y-1.5'>
              <div className='flex justify-between text-sm'><span>Layout</span><span className='text-accent-yellow'>{kitResult.layout.label}</span></div>
              <div className='flex justify-between text-sm'><span>Filled Pads</span><span className='text-accent-yellow'>{filledPads} / {PAD_COUNT}</span></div>
              <div className='flex justify-between text-sm'><span>Source Audio</span><span className='text-accent-yellow'>{formatMb(kitSizeBytes(kit))}</span></div>
              <div className='flex justify-between text-sm'><span>Grid ID</span><span className='text-accent-yellow font-mono'>{kitResult.layout.id}</span></div>
              <p className='text-sm text-text-subtle pt-3 leading-relaxed'>
                The grid is built from the categories this library actually holds. Kits
                sharing a Grid ID lay their pads out identically, so one can replace the
                other on the device. The exported name carries the column half of the ID
                {kitResult.layout.id !== kitResult.layout.columnsId
                  ? ` (${kitResult.layout.columnsId}) — the top row is left off to fit the display on the device.`
                  : '.'}
              </p>
            </div>
          </div>

          {error && (
            <div className='mt-6 text-sm text-danger-text border border-danger-border bg-danger-bg rounded px-3 py-2'>
              {error}
            </div>
          )}
          {notice && (
            <div className='mt-6 text-sm text-warning-amber border border-warning-border bg-warning-bg rounded px-3 py-2'>
              {notice}
            </div>
          )}

        </aside>
      </main>

      {isHelpOpen && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-overlay-strong backdrop-blur-md p-4 overflow-y-auto'>
          <div className='bg-surface-modal border border-border-main rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden'>
            {/* Modal Header */}
            <div className='flex items-center justify-between px-6 sm:px-8 py-5 border-b border-border-dark bg-surface-modal-header shrink-0'>
              <div className='flex items-center gap-3'>
                <HelpCircle size={24} className='text-accent-yellow' />
                <h2 className='text-base sm:text-lg font-bold uppercase tracking-widest text-text-bright'>Kit Creator for Ableton Move — User Manual</h2>
              </div>
              <button
                onClick={() => setIsHelpOpen(false)}
                className='text-text-muted hover:text-text-bright p-1.5 rounded-lg hover:bg-surface-btn-hover transition-colors cursor-pointer'
                aria-label='Close manual'
              >
                <X size={20} />
              </button>
            </div>

            {/* Modal Content Body */}
            <div className='p-6 sm:p-8 overflow-y-auto space-y-7 text-sm sm:text-base text-text-lighter leading-relaxed'>
              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>1. Overview</h3>
                <p>
                  Kit Creator for Ableton Move automatically turns your drum sample collections into hardware-ready Ableton Move preset bundles (<code className='bg-surface-code px-2 py-0.5 rounded text-accent-yellow font-mono text-sm'>.ablpresetbundle</code>). Drop sample folders, customize pad mappings, and export directly to your hardware.
                </p>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>2. Adding & Scanning Sample Folders</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li><strong className='text-text-bright'>Drag & Drop:</strong> Drag any sample folder directly onto the app window.</li>
                  <li><strong className='text-text-bright'>Supported Formats:</strong> Accepts uncompressed <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>.wav</code> and <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>.aiff</code> audio files.</li>
                  <li><strong className='text-text-bright'>Loop Filtering:</strong> Audio loops (detected by tempo or loop keywords) are automatically excluded from drum kit generation.</li>
                  <li><strong className='text-text-bright'>Duplicate Protection:</strong> Folders already present in your list are automatically skipped.</li>
                  <li><strong className='text-text-bright'>Hide a Folder:</strong> The eye icon next to a loaded folder takes it out of the pool without unloading it. The kit re-rolls immediately without those samples, the folder dims in the list, and the eye brings it straight back — handy for auditioning one pack against another. Locked pads keep what they are holding even if its folder is hidden.</li>
                  <li><strong className='text-text-bright'>Remove a Folder:</strong> The cross unloads it for good. Hiding is the reversible one.</li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>3. 4×4 Pad Grid & Controls</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li><strong className='text-text-bright'>Hardware Note Mapping:</strong> Pad 1 (bottom-left) to Pad 16 (top-right) map to MIDI notes 36–51, matching Ableton Move hardware.</li>
                  <li><strong className='text-text-bright'>Keyboard Hotkeys:</strong> Play pads instantly with row keys:
                    <div className='grid grid-cols-4 gap-1.5 max-w-sm text-sm font-mono text-accent-yellow mt-2 bg-surface-pad p-3 rounded-lg border border-border-main text-center font-bold'>
                      <div>1 2 3 4</div>
                      <div>Q W E R</div>
                      <div>A S D F</div>
                      <div>Z X C V</div>
                    </div>
                  </li>
                  <li><strong className='text-text-bright'>Choke Groups:</strong> Closed & Open Hats automatically cut each other (Choke 1). Crashes cut each other (Choke 2).</li>
                  <li><strong className='text-text-bright'>Split Bottom Bar:</strong> Click the left side (<code className='text-accent-yellow font-mono'>Lock</code>) to hold a sample across re-rolls. Click the right side (<code className='text-accent-yellow font-mono'>Refresh</code>) to randomize only that single pad.</li>
                  <li><strong className='text-text-bright'>Exclude Sample:</strong> Click the ban icon in the sample name row to exclude a sample from future kit rolls.</li>
                  <li><strong className='text-text-bright'>Preview Kit:</strong> Plays every pad in order, 750ms apart, so you can hear the whole kit without clicking sixteen times. Clicking anywhere, pressing any key, or hitting the button again stops it.</li>
                  <li><strong className='text-text-bright'>Auto Preview:</strong> Ticking this runs that preview automatically after each Generate Random Kit, so rolling through kits is a listening job rather than a clicking one.</li>
                  <li><strong className='text-text-bright'>Pad Colours:</strong> Each pad is tinted by the category it holds — one hue each for kick, snare, clap, closed hat, open hat, percussion and other. The Breakdown by Type rows use the same hues, so a grid can be read at a glance without reading a word.</li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>4. Presets & Batch Exporting</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li><strong className='text-text-bright'>Preset Naming:</strong> Kit names are a folder prefix, the Grid ID, and a random suffix — <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>MKT-ksho-Vibe</code>. Custom typed prefixes and suffixes are preserved.</li>
                  <li><strong className='text-text-bright'>Grid ID:</strong> A short fingerprint of the pad layout, one letter per column: <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>k</code> kick, <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>s</code> snare, <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>c</code> clap, <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>h</code> closed hat, <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>o</code> open hat, <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>p</code> percussion, <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>x</code> other. Two kits sharing an ID lay their pads out identically, so one drum rack can replace another on the device without relearning where anything sits. The panel shows the full ID, including the shared top row after an underscore; the exported name carries the column half, which is what fits on the Move's display.</li>
                  <li><strong className='text-text-bright'>Batch Export:</strong> Export up to 10 distinct randomized kits at once in a single zip archive.</li>
                  <li><strong className='text-text-bright'>Device Transfer:</strong> Copy exported <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>.ablpresetbundle</code> folders into your Ableton Move hardware preset library.</li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>5. Sample Filters & Processing</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li><strong className='text-text-bright'>Skip Loops:</strong> Leaves out files whose name or folder marks them as a loop — "loop", a bar count, or a tempo like 128bpm. A file that says "break" or "breakbeat" in its own name also counts, but only if it could not be categorised — a snare called "Break Snare" is still a snare, and a pack named "Breaks Vol 2" keeps all of its one-shots.</li>
                  <li><strong className='text-text-bright'>Disable a Type:</strong> Each row of the Breakdown by Type card has an eye icon. Switching a type off leaves every sample of it out of generation, exactly like disabling a source folder, and the grid drops that column. Closed hats take generic hats with them, and percussion takes crashes.</li>
                  <li><strong className='text-text-bright'>Skip Non-Drums:</strong> Leaves out uncategorised files that look like effects, vocals, scratches or melodic material, and anything sitting in an Extras, Imported or Misc folder. Only ever applies to files the app could not categorise, so a sample called "Bass Kick" is unaffected.</li>
                  <li><strong className='text-text-bright'>When a Pool Runs Dry:</strong> A pad whose own category is exhausted takes the nearest sound rather than the next one down some list. Snares and claps cover for each other, the two hats cover for each other, percussion and other cover for each other, and a kick is the last resort for every role but its own. An open-hat pad reaches for closed hats first.</li>
                  <li><strong className='text-text-bright'>Percussion &amp; Other:</strong> These keep separate columns and separate rows, but a pad asking for either draws from both, weighted by how much of each is left — so a library heavy on unclassified samples still fills its percussion pads.</li>
                  <li><strong className='text-text-bright'>Trim Silence:</strong> Trims leading and trailing silence (&lt; -60 dBFS) and re-encodes at the original sample rate and bit depth. Turn it off to copy every sample byte-for-byte. <strong className='text-text-bright'>It only happens on export</strong> — the pads always play your original files untouched, so what you hear while building a kit is the untrimmed sample and nothing on disk is ever modified.</li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>6. Thank You</h3>
                <p className='text-text-light'>
                  Special thanks to{' '}
                  <a
                    href='https://github.com/klingklangmatze/drum-kit-generator'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='text-accent-yellow hover:underline font-medium'
                  >
                    klingklangmatze
                  </a>{' '}
                  for providing great insights on how to create ablpreset files.
                </p>
                <p className='text-text-light'>
                  Drum icon by{' '}
                  <a
                    href='https://www.magnific.com/author/iconfromus/icons'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='text-accent-yellow hover:underline font-medium'
                  >
                    iconfromus
                  </a>{' '}
                  from{' '}
                  <a
                    href='https://www.magnific.com/icon/drum_8584847'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='text-accent-yellow hover:underline font-medium'
                  >
                    Magnific
                  </a>, used under its attribution licence.
                </p>
                <p className='text-text-light'>Other tools for kit creation:</p>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li>
                    <a
                      href='https://www.kit-maker.com/'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-accent-yellow hover:underline font-medium'
                    >
                      Kit-Maker
                    </a>
                  </li>
                  <li>
                    <a
                      href='https://movestudio.reocities.xyz/'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-accent-yellow hover:underline font-medium'
                    >
                      Move Studio
                    </a>
                  </li>
                </ul>
              </section>
            </div>

            {/* Modal Footer */}
            <div className='px-6 sm:px-8 py-4 border-t border-border-dark bg-surface-modal-header flex justify-end shrink-0'>
              <button
                onClick={() => setIsHelpOpen(false)}
                className='px-6 py-2.5 bg-accent-yellow text-text-inverse font-bold uppercase text-sm tracking-wider rounded-lg hover:brightness-110 transition-all cursor-pointer'
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
