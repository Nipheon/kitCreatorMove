import { FolderUp, Loader2, RefreshCw, Eye, EyeOff, HelpCircle, X, Play, Square } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pad } from './components/Pad';
import { Toast } from './components/Toast';
import {
  categoryAccent, chokeGroupFor, chooseLayout, DISPLAY_INDICES,
  PAD_COUNT, poolCategoryFor
} from './padLayout';
import { Category, Sample, SourceFolder } from './types';
import { ExportError, exportBatchKits, exportBatchSeparately, exportKitZip, kitSizeBytes } from './utils/exporter';
import {
  categorizeSample, describeDropReport, getFilesFromDataTransfer, looksLikeLoop, looksNonDrum,
  newDropReport, ScanProgress
} from './utils/fileReader';
import { mergeScannedFolders } from './utils/folderMerge';
import { emptyKit, emptyPadsNotice, generateRandomKit, isUsableSample, KitResult, rerollSinglePad } from './utils/kitGenerator';
import { PROGRESS_DELAY_MS, shouldShowProgress } from './utils/progressVisibility';
import { describeScanProgress, SCAN_UI_INTERVAL_MS, throttle } from './utils/scanProgress';
import {
  buildBatch as buildBatchFor, DEFAULT_PREFIX, generateKitName, heldLayout, kitNameFor,
  lockedFrom as lockedFromPads, PREFIX_LENGTH, prefixForFolders, uniqueKitName
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
  /** One entry per dropped top-level entry while its scan runs; shown as pending rows under Source Folders. */
  const [scanning, setScanning] = useState<ScanProgress[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  /** True while a kit is being drawn (and its samples checked for duplicates). Controls that edit the kit are off meanwhile. */
  const [isGenerating, setIsGenerating] = useState(false);
  const [checkProgress, setCheckProgress] = useState<{ kind: 'pads' | 'kits'; done: number; total: number } | null>(null);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kitPrefix, setKitPrefix] = useState(DEFAULT_PREFIX);
  // Once the user types their own prefix, stop deriving it from the folder list.
  const [prefixEdited, setPrefixEdited] = useState(false);
  const [kitSuffix, setKitSuffix] = useState('KIT');
  const [batchSize, setBatchSize] = useState(1);
  const [batchAsZip, setBatchAsZip] = useState(false);
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
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  const helpDialogRef = useRef<HTMLDivElement>(null);
  // Which pad to audition, and a counter so repeated shuffles of the same pad each fire.
  const [audition, setAudition] = useState<{ index: number; token: number }>({ index: -1, token: 0 });
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [autoPreview, setAutoPreview] = useState(false);
  const [spinningPads, setSpinningPads] = useState<boolean[]>(new Array(PAD_COUNT).fill(false));
  const generationId = useRef(0);
  const generating = useRef(false);
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
  // Detaches the listener waiting for the current step's `pad-started`; stopPreview must
  // remove it, or a stopped sequence resumes when that pad is next played.
  const padStartedCleanup = useRef<(() => void) | null>(null);

  /**
   * Dev convenience: `?seed` on a dev server fills the grid from a real pack's filenames,
   * so the layout can be judged with content in it. Both guards matter — the env check is
   * what lets the bundler drop the seed module from a production build, and the query
   * param is what keeps a normal dev session starting empty like the real thing.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const seed = new URLSearchParams(window.location.search).get('seed');
    if (seed === null) return;
    // `?seed=20` fakes twenty folders, which is how the sidebar's scrolling gets tested.
    const count = Math.min(Math.max(parseInt(seed || '1', 10) || 1, 1), 50);
    let cancelled = false;
    import('./devSeed').then(async ({ devSeedFolders }) => {
      if (cancelled) return;
      const folders = devSeedFolders(count);
      const samples = folders.flatMap(f => f.samples);
      setSourceFolders(folders);
      const seeded = await generateRandomKit(samples, [], { skipLoops: true, skipNonDrums: true });
      if (cancelled) return;
      setKitResult(seeded);
      setKitPrefix(prefixForFolders(folders));
      setKitSuffix(generateKitName(folders[0].name).suffix);
    });
    return () => { cancelled = true; };
  }, []);

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
    padStartedCleanup.current?.();
    padStartedCleanup.current = null;
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
          detach();
          advanceStep();
        }
      };
      const detach = () => {
        window.removeEventListener('pad-started', onPadStarted);
        if (padStartedCleanup.current === detach) padStartedCleanup.current = null;
      };

      window.addEventListener('pad-started', onPadStarted);
      padStartedCleanup.current = detach;

      // Fallback timer in case pad is empty or audio playback fails/errors
      const fallbackTimerId = window.setTimeout(() => {
        detach();
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

    if (generating.current) return;
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

  // Help dialog: focus moves in on open and back to the Help button on close; Escape
  // closes; Tab cycles inside the dialog.
  useEffect(() => {
    if (!isHelpOpen) return;
    const opener = helpButtonRef.current;
    const dialog = helpDialogRef.current;
    dialog?.focus();

    const handleDialogKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsHelpOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || (e.shiftKey && (active === first || active === dialog))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      document.removeEventListener('keydown', handleDialogKeyDown);
      opener?.focus();
    };
  }, [isHelpOpen]);

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

  const exportName = kitNameFor(kitPrefix, kitSuffix, kitResult.layout.columnsId);
  const loopCount = useMemo(() => samples.filter(s => s.isLoop).length, [samples]);
  const nonDrumCount = useMemo(() => samples.filter(s => s.isNonDrum && !s.isLoop).length, [samples]);
  const activeFoldersCount = useMemo(
    () => sourceFolders.filter(f => f.isEnabled !== false).length,
    [sourceFolders]
  );
  const usableCount = useMemo(
    () => samples.filter(s => isUsableSample(s, kitOptions)).length,
    [samples, skipLoops, skipNonDrums, disabledTypes, kitResult]
  );
  // The generator flags duplicates in place, so a new kit result is the signal to recount.
  const skippedDuplicates = useMemo(
    () => samples.filter(s => s.isDuplicate).length,
    [samples, kitResult]
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
  }, [samples, skipLoops, skipNonDrums, disabledTypes, kitResult]);

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
    if (!latest.current.prefixEdited) setKitPrefix(prefixForFolders(folders));
  };

  const lockedFrom = (current: (Sample | null)[]) =>
    lockedFromPads(lockedPads, current);

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

  // The newest committed state, for code that resumes after an await and would otherwise
  // read the values captured when the drop started.
  const latest = useRef({ sourceFolders, kit, lockedPads, kitOptions, prefixEdited, autoPreview });
  latest.current = { sourceFolders, kit, lockedPads, kitOptions, prefixEdited, autoPreview };

  /**
   * Runs one generation and reports to `checkProgress` only once it has taken longer than
   * PROGRESS_DELAY_MS. A newer generation supersedes an older one: the older resolves to
   * `null` and its caller must write nothing. The ref (not the state) is what click handlers
   * check, since state lags a render behind.
   */
  const runGeneration = async <T,>(
    job: (report: (done: number, total: number, kind?: 'pads' | 'kits') => void) => Promise<T>
  ): Promise<T | null> => {
    const id = ++generationId.current;
    generating.current = true;
    setIsGenerating(true);
    const started = Date.now();
    let last: { kind: 'pads' | 'kits'; done: number; total: number } | null = null;
    const show = () => {
      if (id === generationId.current && last && shouldShowProgress(Date.now() - started)) setCheckProgress(last);
    };
    const timer = window.setTimeout(show, PROGRESS_DELAY_MS);
    try {
      const result = await job((done, total, kind = 'pads') => { last = { kind, done, total }; show(); });
      return id === generationId.current ? result : null;
    } finally {
      window.clearTimeout(timer);
      if (id === generationId.current) {
        generating.current = false;
        setIsGenerating(false);
        setCheckProgress(null);
      }
    }
  };

  const lockedDuplicatesNotice = (result: KitResult) => {
    if (!result.lockedDuplicates?.length) return;
    const pads = result.lockedDuplicates.map(i => i + 1).join(', ');
    setNotice(prev => [prev, `Locked pad${result.lockedDuplicates!.length > 1 ? 's' : ''} ${pads} hold${result.lockedDuplicates!.length > 1 ? '' : 's'} the same audio as another locked pad; locks are left as they are.`].filter(Boolean).join(' '));
  };

  const processFiles = async (items: DataTransferItemList) => {
    setIsLoading(true);
    setError(null);

    const report = newDropReport();
    const showCount = (p: ScanProgress) =>
      setScanning(prev => prev.map(row => (row.folder === p.folder ? p : row)));
    const showCountThrottled = throttle(showCount, SCAN_UI_INTERVAL_MS);
    try {
      const scanned = await getFilesFromDataTransfer(items, report, p => {
        // The zero-count calls list every dropped entry at once and must not be throttled away.
        if (p.files === 0) setScanning(prev => (prev.some(row => row.folder === p.folder) ? prev : [...prev, p]));
        else showCountThrottled(p);
      });
      const reportNotes = describeDropReport(report);
      if (reportNotes.length > 0) setNotice(prev => [prev, ...reportNotes].filter(Boolean).join(' '));
      // Read after the await: the scan may have outlived edits made through the keyboard.
      const current = latest.current;
      const candidates = scanned
        .map(folder => ({ name: folder.name || 'Dropped Files', files: folder.files }))
        .filter(folder => folder.files.length > 0);
      const { accepted, skippedDuplicates } = mergeScannedFolders(current.sourceFolders, candidates);
      const newFolders: SourceFolder[] = [];

      for (const folder of accepted) {
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

        newFolders.push({
          id: newId('folder'),
          name: folder.name,
          isEnabled: true,
          samples
        });
      }

      if (newFolders.length === 0) {
        // A drop that changes nothing has to say why, or it reads as the app ignoring you.
        setError(
          skippedDuplicates > 0
            ? skippedDuplicates === 1
              ? 'That folder is already loaded.'
              : `Those ${skippedDuplicates} folders are already loaded.`
            : report.rejected.length > 0
              ? 'None of the dropped samples could be read; see the note above.'
              : 'No .wav or .aiff files found in what you dropped. Move plays those two formats only.'
        );
        return;
      }

      // Computed outside the state updater: updaters must stay pure, and StrictMode
      // double-invokes them.
      const wasEmpty = current.sourceFolders.length === 0;
      const updated = [...current.sourceFolders, ...newFolders];
      const allSamples = enabledSamples(updated);

      setSourceFolders(updated);
      // Same batch as the real rows, so a pending row is swapped, not followed by a second one.
      setScanning([]);
      // The drop itself hashes nothing; only samples drawn into this kit are read. This
      // supersedes any generation still in flight, which then writes nothing.
      const next = allSamples.length > 0
        ? await runGeneration(report => generateRandomKit(
          allSamples,
          current.lockedPads.map((locked, idx) => (locked ? current.kit[idx] : null)),
          current.kitOptions,
          undefined,
          { onProgress: report }
        ))
        : null;
      if (next) {
        setKitResult(next);
        lockedDuplicatesNotice(next);
      }
      // Re-read: the prefix may have been typed while the draw ran.
      if (!latest.current.prefixEdited) setKitPrefix(prefixForFolders(updated));
      // The suffix is only rolled for the first drop; after that it is the user's,
      // changed by the Randomize Suffix button.
      if (wasEmpty) setKitSuffix(generateKitName(newFolders[0].name).suffix);
    } catch (err) {
      console.error('Failed to process files:', err);
      setError('Error processing files. Please try again.');
    } finally {
      setScanning([]);
      setIsLoading(false);
    }
  };

  // Deliberately not memoised: a stale closure here would make every drop after the
  // first build its kit from that folder alone and ignore locked pads. processFiles reads
  // `latest` after its scan, so changes made while it ran are kept.
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    if (isLoading) return; // two overlapping scans would both capture the same state
    if (e.dataTransfer.items) processFiles(e.dataTransfer.items);
  };

  // Pads that stay put keep their roles: without this, dropping the only source of a role
  // re-derives the grid under pads that did not move. An empty kit holds nothing, and the
  // empty-library layout must not be held.
  const heldLayoutFor = () => heldLayout(kit, kitResult.layout);

  const removeFolder = async (id: string) => {
    if (generating.current) return;
    const removed = sourceFolders.find(f => f.id === id);
    const updated = sourceFolders.filter(f => f.id !== id);
    const remaining = enabledSamples(updated);
    const removedIds = new Set(removed?.samples.map(s => s.id) ?? []);
    const heldLayout = heldLayoutFor();

    // Keep every pad whose sample survived; only the emptied ones get refilled.
    const survivors = kit.map((sample, idx) =>
      lockedPads[idx] || (sample && !removedIds.has(sample.id)) ? sample : null
    );

    const next: KitResult | null = remaining.length > 0
      ? await runGeneration(report => generateRandomKit(remaining, survivors, kitOptions, heldLayout, { onProgress: report }))
      : {
        kit: survivors.map((s, idx) => (lockedPads[idx] ? s : null)),
        layout: chooseLayout(remaining),
        substituted: [],
        empty: [],
        unavailableRoles: []
      };
    if (!next) return; // superseded: nothing stale is written

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

  const toggleFolder = async (id: string) => {
    if (generating.current) return;
    const target = sourceFolders.find(f => f.id === id);
    if (!target) return;
    const willDisable = target.isEnabled !== false;
    const updated = sourceFolders.map(f => (f.id === id ? { ...f, isEnabled: !willDisable } : f));
    const remaining = enabledSamples(updated);
    const targetIds = new Set(target.samples.map(s => s.id));
    const heldLayout = heldLayoutFor();

    const survivors = kit.map((sample, idx) => {
      if (lockedPads[idx]) return sample;
      if (willDisable && sample && targetIds.has(sample.id)) return null;
      return sample;
    });

    const next: KitResult | null = remaining.length > 0
      ? await runGeneration(report => generateRandomKit(remaining, survivors, kitOptions, heldLayout, { onProgress: report }))
      : {
        kit: survivors.map((s, idx) => (lockedPads[idx] ? s : null)),
        layout: chooseLayout(remaining),
        substituted: [],
        empty: [],
        unavailableRoles: []
      };
    if (!next) return;

    setSourceFolders(updated);
    setKitResult(next);
    syncPrefix(updated);
  };

  const handleExcludeSample = async (sampleId: string, padIndex?: number) => {
    if (generating.current) return;
    const updated = sourceFolders.map(f => ({
      ...f,
      samples: f.samples.map(s => (s.id === sampleId ? { ...s, isExcluded: true } : s))
    }));
    const remaining = enabledSamples(updated);
    const survivors = kit.map(sample => (sample?.id !== sampleId ? sample : null));
    const heldLayout = heldLayoutFor();

    const next: KitResult | null = remaining.length > 0
      ? await runGeneration(report => generateRandomKit(remaining, survivors, kitOptions, heldLayout, { onProgress: report }))
      : { kit: survivors, layout: chooseLayout(remaining), substituted: [], empty: [], unavailableRoles: [] };
    if (!next) return;

    // The lock belonged to the excluded sample; its replacement was never chosen by the user.
    setLockedPads(prev => prev.map((locked, idx) => (kit[idx]?.id === sampleId ? false : locked)));
    setSourceFolders(updated);
    setKitResult(next);
    if (padIndex !== undefined) {
      setAudition(prev => ({ index: padIndex, token: prev.token + 1 }));
    }
  };

  const randomizeKit = async () => {
    if (generating.current) return;
    stopPreview();
    stopSpinAnimation();

    if (samples.length > 0) {
      const next = await runGeneration(report => generateRandomKit(samples, lockedFrom(kit), kitOptions, undefined, { onProgress: report }));
      if (!next) return;
      setKitResult(next);
      lockedDuplicatesNotice(next);

      if (latest.current.autoPreview) {
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

  const rerollPad = async (index: number) => {
    if (generating.current) return;
    if (samples.length > 0 && !lockedPads[index]) {
      const next = await runGeneration(report => rerollSinglePad(samples, kit, index, kitOptions, kitResult.layout, { onProgress: report }));
      if (!next) return;
      setKitResult(next);
      setAudition(prev => ({ index, token: prev.token + 1 }));
    }
  };

  /**
   * These two change the pool the *next* kit is drawn from; they deliberately do not
   * re-roll the current one. They used to, so the toggle would not look inert — but the
   * feedback now sits right above them: the usable count and the per-type figures move
   * the instant either is clicked, without throwing away the kit you were listening to.
   *
   * A kit generated before the filter changed can therefore still hold a sample the
   * filter would now exclude. That is the intended trade: nothing is silently removed
   * from under you, and the next Generate applies the filter.
   */
  const toggleSkipLoops = (next: boolean) => setSkipLoops(next);

  const toggleSkipNonDrums = (next: boolean) => setSkipNonDrums(next);

  /**
   * Switches a whole type off. Regenerates immediately for the same reason the other
   * filters do — a toggle that changes nothing visible reads as broken — and the new set
   * is passed explicitly rather than read back from state, which would still hold the old
   * one this tick.
   */
  const toggleType = async (category: Category) => {
    if (generating.current) return;
    const next = new Set(disabledTypes);
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    setDisabledTypes(next);
    if (samples.length > 0) {
      const result = await runGeneration(report => generateRandomKit(samples, lockedFrom(kit), { ...kitOptions, disabledTypes: next }, undefined, { onProgress: report }));
      if (result) {
        setKitResult(result);
        lockedDuplicatesNotice(result);
      }
    }
  };

  const toggleLock = (index: number) => {
    if (generating.current) return;
    setLockedPads(prev => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  };

  const buildBatch = () =>
    runGeneration(report => buildBatchFor({
      kit, layout: kitResult.layout, exportName, exportedNames: exportedNames.current,
      samples, kitOptions, batchSize, prefix: kitPrefix, lockedPads,
      onKit: (done, total) => report(done, total, 'kits')
    }));

  const exportKit = async () => {
    if (generating.current || kit.every(s => s === null)) return;

    // Built before the confirm so the guard sums the real kits 2..n, not the on-screen kit
    // times the batch size. Trimming only shrinks, hence "at most".
    const batch = batchSize > 1 ? await buildBatch() : null;
    if (batchSize > 1 && !batch) return; // superseded by a newer generation
    // Separate downloads hold one bundle at a time, so the largest kit is what matters;
    // the zip holds every bundle at once, so it stays the sum.
    const kitBytes = batch ? batch.map(entry => kitSizeBytes(entry.kit)) : [kitSizeBytes(kit)];
    const bytes = batch && !batchAsZip
      ? Math.max(...kitBytes)
      : kitBytes.reduce((total, size) => total + size, 0);
    if (bytes > SIZE_WARN_BYTES) {
      const proceed = window.confirm(
        `This export is at most ${formatMb(bytes)} of audio. Bundles are built in memory and may fail at this size. Continue?`
      );
      if (!proceed) return;
    }

    setIsExporting(true);
    setError(null);
    setNotice(null);
    const onProgress = (done: number, total: number) => setExportProgress({ done, total });
    const names: string[] = [];

    try {
      let report;
      let emptyNote: string | null = null;
      if (batch) {
        emptyNote = emptyPadsNotice(batch);
        if (batchAsZip) {
          names.push(...batch.map(entry => entry.name));
          report = await exportBatchKits(batch, kitPrefix, { trimSilence, onProgress });
        } else {
          const result = await exportBatchSeparately(batch, { trimSilence, onProgress });
          names.push(...result.downloaded);
          report = result.report;
          setNotice(prev => [prev, `Downloaded ${result.downloaded.length} files. If your browser asked to allow multiple downloads, choose Allow; if files are missing, use "Download as one zip".`].filter(Boolean).join(' '));
        }
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

      const trimNotes: string[] = [];
      if (report.trimFailures > 0) {
        trimNotes.push(`${report.trimFailures} sample(s) could not be trimmed and were exported unchanged.`);
      }
      if (report.trimSkipped > 0) {
        trimNotes.push(`${report.trimSkipped} sample(s) are in a format that cannot be trimmed (AIFF, 8-bit, 32-bit or unusual sample rate) and were exported unchanged.`);
      }
      if (emptyNote) trimNotes.push(emptyNote);
      if (trimNotes.length > 0) {
        // Appended, not replaced: the rename notice set above must survive.
        setNotice(prev => [prev, ...trimNotes].filter(Boolean).join(' '));
      }
    } catch (err) {
      console.error('Export failed:', err);
      // Files already downloaded by a failed separate export are real, so their names are taken.
      if (err instanceof ExportError) names.push(...err.downloaded);
      names.forEach(name => exportedNames.current.add(name));
      setError(
        err instanceof ExportError
          ? err.userMessage
          : 'Export failed. Nothing was downloaded. Details are in the browser console.'
      );
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
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-darkest/90 backdrop-blur-sm border-2 border-dashed border-accent-yellow m-4 rounded-xl">
          <div className="text-center">
            <FolderUp className="w-16 h-16 text-accent-yellow mx-auto mb-4 animate-pulse" />
            <h2 className="text-2xl font-bold uppercase tracking-widest">Drop Sample Folders Here</h2>
            <p className="text-text-muted mt-2 text-sm uppercase tracking-wider">.wav and .aiff files</p>
          </div>
        </div>
      )}
      {/* Invisible while a drop is processed: it only swallows clicks so the state the scan
          will merge into cannot change under it. Progress lives in the pending folder rows
          and, for the duplicate check, under the Generate button. */}
      {isLoading && !isDragging && <div className="fixed inset-0 z-50 cursor-progress" aria-hidden="true" />}

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
            ref={helpButtonRef}
            type='button'
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
        <aside className='w-full lg:w-72 bg-surface-panel border-b lg:border-b-0 lg:border-r border-border-dark p-6 flex flex-col shrink-0 lg:overflow-hidden'>
          {/* Heading, drop zone, list and the count block are siblings of the sidebar on
              purpose, so the list is the only one that gives up room: it takes what is
              left and scrolls, and twenty folders can never push the sample count or the
              filters below the fold.

              Wrapping the first three in a `flex-1 min-h-0` block was the previous
              attempt. The block shrank below its own contents on a short window and the
              heading and drop zone painted over the count beneath; capping the list
              instead stopped the overlap but put the count off screen again. Only one of
              them may shrink, and it has to be the list. */}
          <h2 className='text-sm uppercase tracking-[0.2em] font-semibold text-text-subtle mb-4 shrink-0'>Source Folders</h2>
          {/* A line, not a drop zone. The whole window is the drop target — `handleDrop`
              sits on the app root — so a bordered box here only claimed vertical space
              the folder list wanted, while implying the drop had to land inside it. */}
          <p className='text-sm text-text-subtle mb-4 shrink-0'>
            Drag sample folders anywhere on this window.
          </p>
          <div className='pad-folder-list mb-6 lg:flex-1 lg:min-h-[3.25rem] lg:overflow-y-auto -mr-2 pr-2'>
            {sourceFolders.map(folder => (
              <div key={folder.id} className={`space-y-2 mt-2 ${folder.isEnabled === false ? 'opacity-50' : ''}`}>
                <div className='bg-surface-pad px-3 py-2 rounded flex items-center justify-between group'>
                  <div className='flex items-center gap-2 overflow-hidden flex-1'>
                    <button
                      onClick={() => toggleFolder(folder.id)}
                      disabled={isGenerating}
                      className='text-text-muted-dark hover:text-text-bright transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed'
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
                    disabled={isGenerating}
                    className='text-sm font-bold text-text-muted-dark group-hover:text-danger-text ml-2 disabled:opacity-40 disabled:cursor-not-allowed'
                    aria-label={`Remove ${folder.name}`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            {scanning.map(row => {
              const text = describeScanProgress(row.folder, row.files);
              return (
                <div key={`scan:${row.folder}`} className='space-y-2 mt-2'>
                  <div className='relative bg-surface-pad px-3 py-2 rounded overflow-hidden'>
                    <div className='flex items-center gap-2'>
                      {/* Same width as the Eye button of a real row, so the name does not shift on swap. */}
                      <span className='w-[15px] shrink-0' aria-hidden='true' />
                      <span className='text-sm truncate text-text-bright flex-1'>{row.folder}</span>
                    </div>
                    <div className='text-xs text-text-muted mt-0.5 pl-[23px]' aria-hidden='true'>{text.visible}</div>
                    <div role='status' className='sr-only'>{text.announce}</div>
                    <div className='scan-bar absolute left-0 right-0 bottom-0 h-0.5 bg-border-main' aria-hidden='true'>
                      <div className='scan-bar-fill h-full bg-accent-yellow' />
                    </div>
                  </div>
                </div>
              );
            })}
            {sourceFolders.length === 0 && scanning.length === 0 && (
              <div className='text-sm text-text-subtle text-center mt-4'>No folders loaded</div>
            )}
          </div>
          <div className='mt-auto shrink-0 space-y-2'>
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

              {/* Inside the card, between the count and the breakdown: both filters change
                  the number directly above them and the per-type figures directly below,
                  so this is the one place where cause and effect are both on screen.
                  Type matches the card's own rows — text-sm, uppercase, medium. */}
              <div className='pt-3 border-t border-border-dark space-y-1.5'>
                <label className='flex items-center gap-2 text-sm text-text-muted uppercase font-medium cursor-pointer'>
                  <input
                    type='checkbox'
                    checked={skipLoops}
                    onChange={(e) => toggleSkipLoops(e.target.checked)}
                    className='accent-accent-yellow w-3.5 h-3.5'
                  />
                  Skip loops{loopCount > 0 ? ` (${loopCount})` : ''}
                </label>
                <label className='flex items-center gap-2 text-sm text-text-muted uppercase font-medium cursor-pointer'>
                  <input
                    type='checkbox'
                    checked={skipNonDrums}
                    onChange={(e) => toggleSkipNonDrums(e.target.checked)}
                    className='accent-accent-yellow w-3.5 h-3.5'
                  />
                  Skip non-drums{nonDrumCount > 0 ? ` (${nonDrumCount})` : ''}
                </label>
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
                              disabled={total === 0 || isGenerating}
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
                  {skippedDuplicates > 0 && (
                    <div className='pt-2 text-xs text-text-muted uppercase tracking-wider font-medium'>
                      Skipped duplicates: {skippedDuplicates.toLocaleString()}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </aside>

        <section className='w-full bg-surface-darkest flex flex-col items-center justify-center gap-6 p-4 sm:p-6 lg:flex-1 lg:min-h-0'>
          {/* The grid sizes itself to the smaller of the stage's two dimensions, so it is
              never cut off on a short window and keeps growing on a large one. The old
              fixed 700px square did both wrongly.

              The stage gets its height two different ways on purpose. Side by side with
              the sidebars it takes the row's leftover height (`lg:flex-1`). Stacked, the
              page scrolls and there IS no leftover height — `flex-1` there resolved to
              32px while the stage kept its minimum, so the grid painted straight over the
              sidebar. Below `lg` the section is content-sized and the stage carries its
              own minimum instead. */}
          <div className='pad-stage w-full min-h-[min(86vw,60vh)] lg:flex-1 lg:min-h-0 grid place-items-center'>
            <div className='pad-grid grid grid-cols-4 grid-rows-4 gap-2 sm:gap-3'>
              {DISPLAY_INDICES.map((index) => (
                <Pad
                  key={index}
                  index={index}
                  sample={kit[index]}
                  expectedCategory={kitResult.layout.roles[index]}
                  chokeGroup={chokeGroupFor(kit[index])}
                  isLocked={lockedPads[index]}
                  isBusy={isGenerating}
                  onToggleLock={() => toggleLock(index)}
                  onExclude={handleExcludeSample}
                  onReroll={rerollPad}
                  auditionToken={audition.index === index ? audition.token : 0}
                  isSpinning={spinningPads[index]}
                />
              ))}
            </div>
          </div>

          <Toast
            isVisible={showWarning}
            unavailableRoles={kitResult.unavailableRoles}
            substitutedCount={kitResult.substituted.length}
            emptyCount={kitResult.empty.length}
            onClose={dismissWarning}
          />

          <div className='relative flex items-center gap-3 sm:gap-4 flex-wrap justify-center'>
            {/* Only appears once a check has run past PROGRESS_DELAY_MS; absolutely placed so
                it never moves the grid. */}
            {checkProgress?.kind === 'pads' && (
              <div role='status' className='pointer-events-none absolute top-full left-0 right-0 mt-2 text-sm text-text-muted uppercase tracking-wider text-center'>
                Checking samples {checkProgress.done} / {checkProgress.total}
              </div>
            )}
            <button
              onClick={randomizeKit}
              className='px-8 py-3 bg-accent-yellow text-text-inverse font-bold uppercase text-sm tracking-widest rounded-full hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_24px_var(--accent-yellow-glow)] cursor-pointer'
              disabled={usableCount === 0 || isGenerating}
            >
              Generate Random Kit
            </button>
            <div className='flex items-center gap-3'>
              <button
                onClick={previewKit}
                disabled={isEmpty || isGenerating}
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
            <div className='space-y-2' role='group' aria-labelledby='preset-name-label'>
              <div className='flex justify-between items-center'>
                <span id='preset-name-label' className='text-sm text-text-muted uppercase'>Preset Name</span>
                <button
                  type='button'
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
                Export multiple random kits at once. Locked pads remain the same across all.
              </p>
            </div>

            {batchSize > 1 && (
              <div>
                <label className='flex items-center gap-2 text-sm text-text-muted uppercase cursor-pointer'>
                  <input
                    type='checkbox'
                    checked={batchAsZip}
                    onChange={(e) => setBatchAsZip(e.target.checked)}
                    className='accent-accent-yellow w-4 h-4'
                  />
                  Download as one zip
                </label>
                <p className='text-sm leading-snug text-text-subtle'>
                  Off: each kit downloads as its own file. The browser may ask once to allow multiple downloads.
                </p>
              </div>
            )}

            <div>
              <label className='flex items-center gap-2 text-sm text-text-muted uppercase cursor-pointer'>
                <input
                  type='checkbox'
                  checked={trimSilence}
                  onChange={(e) => setTrimSilence(e.target.checked)}
                  className='accent-accent-yellow w-4 h-4'
                />
                Trim silence (start &amp; end)
              </label>
              <p className='text-sm leading-snug text-text-subtle'>
                Cuts anything below -60 dBFS from each end. Applied on export only — pads
                always audition the original file.
              </p>
            </div>

            {/* Directly under the slider it belongs to: the batch size decides what this
                button produces, and reading the count then hunting for the action at the
                far end of the panel put them out of sight of each other. */}
            <div>
              {(checkProgress?.kind === 'kits' || (isExporting && exportProgress && exportProgress.total > 1)) && (() => {
                const p = checkProgress?.kind === 'kits' ? checkProgress : exportProgress!;
                return (
                  <div className='text-sm text-text-muted uppercase tracking-wider mb-2 text-center'>
                    Kit {Math.min(p.done + 1, p.total)} of {p.total}
                  </div>
                );
              })()}
              <button
                onClick={exportKit}
                disabled={isEmpty || isExporting || isGenerating}
                className='w-full py-3.5 bg-surface-solid text-text-inverse font-bold uppercase text-sm tracking-[0.2em] rounded flex items-center justify-center gap-2 hover:bg-surface-solid-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer'
              >
                {isExporting && <Loader2 className='w-4 h-4 animate-spin' />}
                {isExporting ? 'Building Bundle…' : 'Export To Move'}
              </button>
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
          <div
            ref={helpDialogRef}
            role='dialog'
            aria-modal='true'
            aria-labelledby='help-dialog-title'
            tabIndex={-1}
            className='bg-surface-modal border border-border-main rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden outline-none'
          >
            {/* Modal Header */}
            <div className='flex items-center justify-between px-6 sm:px-8 py-5 border-b border-border-dark bg-surface-modal-header shrink-0'>
              <div className='flex items-center gap-3'>
                <HelpCircle size={24} className='text-accent-yellow' />
                <h2 id='help-dialog-title' className='text-base sm:text-lg font-bold uppercase tracking-widest text-text-bright'>Kit Creator for Ableton Move — User Manual</h2>
              </div>
              <button
                type='button'
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
                  Kit Creator for Ableton Move automatically turns your drum sample collections into hardware-ready Ableton Move preset bundles (<code className='bg-surface-code px-2 py-0.5 rounded text-accent-yellow font-mono text-sm'>.ablpresetbundle</code>). Drop sample folders, customize pad mappings, and export a bundle you can upload to your hardware.
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
                  <li><strong className='text-text-bright'>Batch Export:</strong> Export up to 10 distinct randomized kits at once. By default each kit downloads as its own <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>.ablpresetbundle</code> file, one after another; your browser may ask once to allow multiple downloads, so choose Allow. Tick Download as one zip to get a single zip archive instead.</li>
                  <li><strong className='text-text-bright'>Device Transfer:</strong> Each exported <code className='text-text-bright font-mono text-sm bg-surface-code px-1.5 py-0.5 rounded'>.ablpresetbundle</code> is a single file, not a folder: upload it to your Ableton Move. If you chose Download as one zip, unzip it first.</li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>5. Sample Filters & Processing</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li><strong className='text-text-bright'>When Filters Apply:</strong> Skip Loops and Skip Non-Drums change what the <em>next</em> kit is built from. The counts above them update straight away, but the kit on screen is left alone — nothing is taken off a pad you are listening to. Hit Generate to apply them.</li>
                  <li><strong className='text-text-bright'>Skip Loops:</strong> Leaves out files whose name or folder marks them as a loop — "loop", a bar count, or a tempo like 128bpm. A file that says "break" or "breakbeat" in its own name also counts, but only if it could not be categorised — a snare called "Break Snare" is still a snare, and a pack named "Breaks Vol 2" keeps all of its one-shots.</li>
                  <li><strong className='text-text-bright'>Disable a Type:</strong> Each row of the Breakdown by Type card has an eye icon. Switching a type off leaves every sample of it out of generation, exactly like disabling a source folder, and the grid drops that column. Closed hats take generic hats with them, and percussion takes crashes.</li>
                  <li><strong className='text-text-bright'>Skip Non-Drums:</strong> Leaves out uncategorised files that look like effects, vocals, scratches or melodic material, and anything sitting in an Extras, Imported or Misc folder. Only ever applies to files the app could not categorise, so a sample called "Bass Kick" is unaffected.</li>
                  <li><strong className='text-text-bright'>When a Pool Runs Dry:</strong> A pad whose own category is exhausted takes the nearest sound rather than the next one down some list. Snares and claps cover for each other, the two hats cover for each other, percussion and other cover for each other, and a kick is the last resort for every role but its own. An open-hat pad reaches for closed hats first.</li>
                  <li><strong className='text-text-bright'>Percussion &amp; Other:</strong> These keep separate columns and separate rows, but a pad asking for either draws from both, weighted by how much of each is left — so a library heavy on unclassified samples still fills its percussion pads.</li>
                  <li><strong className='text-text-bright'>Trim Silence:</strong> Trims leading and trailing silence (&lt; -60 dBFS) and re-encodes at the original sample rate and bit depth. Turn it off to copy every sample byte-for-byte. <strong className='text-text-bright'>It only happens on export</strong> — the pads always play your original files untouched, so what you hear while building a kit is the untrimmed sample and nothing on disk is ever modified.</li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>6. Privacy</h3>
                <p>
                  <strong className='text-text-bright'>Your samples never leave your computer.</strong> There is no
                  server and no upload: the files are read, categorised, trimmed and packaged
                  into a zip by your browser, and the finished bundle is handed straight back to
                  your downloads folder. Closing the tab is all it takes to clear it — nothing
                  was stored anywhere else.
                </p>
                <p className='text-text-subtle'>
                  The one exception is ordinary web analytics: Cloudflare Web Analytics and Vercel
                  Web Analytics count visits (page views, referrer, country, browser and device
                  type), the same as any website. Your samples, your kits and your file names
                  never leave the page.
                </p>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>7. Source Code &amp; Contact</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li>
                    <strong className='text-text-bright'>Repository:</strong>{' '}
                    <a
                      href='https://github.com/Nipheon/kitCreatorMove'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-accent-yellow hover:underline font-medium'
                    >
                      github.com/Nipheon/kitCreatorMove
                    </a>{' '}
                    — the whole app, under the BSD Zero Clause licence: do what you like
                    with it, no attribution needed.
                  </li>
                  <li>
                    <strong className='text-text-bright'>Bugs and ideas:</strong>{' '}
                    <a
                      href='https://github.com/Nipheon/kitCreatorMove/issues'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-accent-yellow hover:underline font-medium'
                    >
                      open an issue
                    </a>
                    . A sample pack that lays out oddly is the most useful kind of report —
                    the folder names alone usually explain it.
                  </li>
                  <li>
                    <strong className='text-text-bright'>Contact:</strong>{' '}
                    <a
                      href='mailto:uuemoswsq@mozmail.com'
                      className='text-accent-yellow hover:underline font-mono text-sm'
                    >
                      uuemoswsq@mozmail.com
                    </a>
                  </li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>8. Thank You</h3>
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
                <p className='text-text-light'>
                  Check out{' '}
                  <a
                    href='https://www.kit-maker.com/'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='text-accent-yellow hover:underline font-medium'
                  >
                    Kit Maker
                  </a>{' '}
                  and{' '}
                  <a
                    href='https://movestudio.reocities.xyz/'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='text-accent-yellow hover:underline font-medium'
                  >
                    Move Studio
                  </a>{' '}
                  for other great tools for kit creation.
                </p>
              </section>
            </div>

            {/* Modal Footer */}
            <div className='px-6 sm:px-8 py-4 border-t border-border-dark bg-surface-modal-header flex justify-end shrink-0'>
              <button
                type='button'
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
