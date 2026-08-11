import { FolderUp, Loader2, RefreshCw, Eye, EyeOff, HelpCircle, X, Play, Square } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pad } from './components/Pad';
import { chokeGroupFor, chooseLayout, DISPLAY_INDICES, PAD_COUNT } from './padLayout';
import { Sample, SourceFolder } from './types';
import { exportBatchKits, exportKitZip, kitSizeBytes } from './utils/exporter';
import { categorizeSample, getFilesFromDataTransfer, looksLikeLoop } from './utils/fileReader';
import { emptyKit, generateRandomKit, isUsableSample, KitResult, rerollSinglePad } from './utils/kitGenerator';
import { DEFAULT_PREFIX, generateKitName, prefixForFolders } from './utils/kitNaming';

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

  const stopSpinAnimation = React.useCallback(() => {
    spinTimerIds.current.forEach(id => clearTimeout(id));
    spinTimerIds.current = [];
    setSpinningPads(new Array(PAD_COUNT).fill(false));
  }, []);

  const stopPreview = React.useCallback(() => {
    lastStoppedTime.current = Date.now();
    previewTimerIds.current.forEach(id => clearTimeout(id));
    previewTimerIds.current = [];
    setIsPreviewing(false);
    window.dispatchEvent(new CustomEvent('stop-all-audio'));
  }, []);

  const startPreview = React.useCallback(() => {
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

    // 100ms tick to ensure React effects & audio.load() buffer before pad 0 fires
    const initialTimerId = window.setTimeout(playNextStep, 100);
    previewTimerIds.current.push(initialTimerId);
  }, [stopPreview]);

  const previewKit = React.useCallback(() => {
    if (isPreviewing || Date.now() - lastStoppedTime.current < 200) {
      stopPreview();
      return;
    }

    startPreview();
  }, [isPreviewing, stopPreview, startPreview]);

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

  useEffect(() => {
    if (kitResult.substituted.length > 0 || kitResult.empty.length > 0) {
      setShowWarning(true);
      const timer = setTimeout(() => setShowWarning(false), 5000);
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

  const kitOptions = { skipLoops };
  const loopCount = useMemo(() => samples.filter(s => s.isLoop).length, [samples]);
  const usableCount = useMemo(
    () => samples.filter(s => isUsableSample(s, { skipLoops })).length,
    [samples, skipLoops]
  );

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

          samples.push({
            id: newId('sample'),
            file,
            name: file.name,
            category: categorizeSample(file.name, path),
            isLoop: looksLikeLoop(file.name, path),
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
        empty: []
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
          empty: []
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
        : { kit: survivors, layout: chooseLayout(remaining), substituted: [], empty: [] }
    );
    if (padIndex !== undefined) {
      setAudition(prev => ({ index: padIndex, token: prev.token + 1 }));
    }
  };

  const randomizeKit = () => {
    stopPreview();
    stopSpinAnimation();

    if (samples.length > 0) {
      setKitResult(generateRandomKit(samples, lockedFrom(kit), kitOptions));

      if (autoPreview) {
        startPreview();
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
      setKitResult(generateRandomKit(samples, lockedFrom(kit), { skipLoops: next }));
    }
  };

  const toggleLock = (index: number) => {
    setLockedPads(prev => {
      const next = [...prev];
      next[index] = !next[index];
      return next;
    });
  };

  const buildBatch = () => {
    const currentName = `${kitPrefix}-${kitSuffix}`;
    const used = new Set([currentName]);
    const kits = [{ kit: [...kit], name: currentName }];

    for (let i = 1; i < batchSize; i++) {
      const next = generateRandomKit(samples, lockedFrom(kit), kitOptions);
      let name = `${kitPrefix}-${generateKitName('').suffix}`;
      // Fall back to a counter rather than appending repeatedly, which produced
      // names like NAME-Zap-3-3-3.
      if (used.has(name)) name = `${kitPrefix}-${generateKitName('').suffix}-${i + 1}`;
      used.add(name);
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
      const report = batchSize > 1
        ? await exportBatchKits(buildBatch(), kitPrefix, { trimSilence, onProgress })
        : await exportKitZip(kit, `${kitPrefix}-${kitSuffix}`, { trimSilence, onProgress });

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

      <header className='flex items-center justify-between px-8 py-4 border-b border-border-dark bg-surface-header shrink-0'>
        <div className='flex items-center gap-3'>
          <div className='w-8 h-8 bg-accent-yellow rounded-sm flex items-center justify-center'>
            <div className='w-4 h-4 border-2 border-black rotate-45'></div>
          </div>
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
                    className='text-sm font-bold text-text-muted-dark group-hover:text-red-400 ml-2'
                    aria-label={`Remove ${folder.name}`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            {sourceFolders.length === 0 && (
              <div className='text-sm text-text-muted-dark text-center mt-4'>No folders loaded</div>
            )}
          </div>
          <div className='mt-auto'>
            <div className='p-4 bg-surface-card rounded-lg border border-border-dark'>
              <div className='flex justify-between text-sm mb-2 text-text-muted uppercase'>
                <span>Usable Samples</span>
                <span>{usableCount.toLocaleString()} / {samples.length.toLocaleString()}</span>
              </div>
              <div className='w-full bg-border-main h-1.5 rounded-full overflow-hidden'>
                <div className='bg-accent-yellow h-full transition-all' style={{ width: samples.length > 0 ? `${Math.round((usableCount / samples.length) * 100)}%` : '0%' }}></div>
              </div>
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

          {/* Hidden UI container: code logic preserved */}
          <div className='hidden h-10 mb-2 flex-col items-center justify-center shrink-0'>
            {showWarning && (kitResult.substituted.length > 0 || kitResult.empty.length > 0) && (
              <div className='text-sm text-warning-amber uppercase tracking-wider text-center space-y-1 transition-opacity duration-500'>
                {kitResult.substituted.length > 0 && (
                  <div>{kitResult.substituted.length} pad(s) filled from a different category</div>
                )}
                {kitResult.empty.length > 0 && (
                  <div>{kitResult.empty.length} pad(s) left empty — not enough samples</div>
                )}
              </div>
            )}
          </div>

          <div className='flex items-center gap-3 sm:gap-4 flex-wrap justify-center'>
            <button
              onClick={randomizeKit}
              className='px-8 py-3 bg-accent-yellow text-black font-bold uppercase text-sm tracking-widest rounded-full hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_15px_rgba(232,229,216,0.2)] cursor-pointer'
              disabled={usableCount === 0}
            >
              Generate Random Kit
            </button>
            <div className='flex items-center gap-3'>
              <button
                onClick={previewKit}
                disabled={isEmpty}
                className='px-6 py-3 bg-surface-pad border border-border-main hover:border-accent-yellow text-text-bright hover:text-accent-yellow font-bold uppercase text-sm tracking-widest rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center gap-2'
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
                  className='accent-accent-yellow w-4 h-4 cursor-pointer'
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
                  className='text-sm text-accent-yellow hover:text-white transition-colors flex items-center gap-1 cursor-pointer'
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
                  placeholder='PREFIX'
                  maxLength={12}
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
              <p className='text-sm leading-snug text-text-muted-dark'>
                Export multiple random kits in one zip. Locked pads remain the same across all.
              </p>
            </div>

            <div className='space-y-2'>
              <label className='flex items-center gap-2 text-sm text-text-muted uppercase cursor-pointer'>
                <input
                  type='checkbox'
                  checked={skipLoops}
                  onChange={(e) => toggleSkipLoops(e.target.checked)}
                  className='accent-accent-yellow w-4 h-4'
                />
                Skip loops{loopCount > 0 ? ` (${loopCount} found)` : ''}
              </label>
              <p className='text-sm leading-snug text-text-muted-dark'>
                Leaves out files whose name or folder marks them as a loop — "loop",
                a bar count, or a tempo like 128bpm.
              </p>
            </div>

            <div className='space-y-2'>
              <label className='flex items-center gap-2 text-sm text-text-muted uppercase cursor-pointer'>
                <input
                  type='checkbox'
                  checked={trimSilence}
                  onChange={(e) => setTrimSilence(e.target.checked)}
                  className='accent-accent-yellow w-4 h-4'
                />
                Trim silence (start & end)
              </label>
              <p className='text-sm leading-snug text-text-muted-dark'>
                Re-encodes trimmed samples at their original sample rate and bit depth.
                Turn off to copy every sample byte-for-byte.
              </p>
            </div>

            <div className='pt-6 border-t border-border-dark space-y-1.5'>
              <div className='flex justify-between text-sm'><span>Layout</span><span className='text-accent-yellow'>{kitResult.layout.label}</span></div>
              <div className='flex justify-between text-sm'><span>Filled Pads</span><span className='text-accent-yellow'>{filledPads} / {PAD_COUNT}</span></div>
              <div className='flex justify-between text-sm'><span>Source Audio</span><span className='text-accent-yellow'>{formatMb(kitSizeBytes(kit))}</span></div>
              <p className='text-sm text-text-muted-dark pt-3 leading-relaxed'>
                {kitResult.layout.id === 'minimal-layout'
                  ? 'Only generic hats, kicks and snares were found, so each row is Kick, Snare, Snare, Hat.'
                  : kitResult.layout.id === 'generic-hats'
                    ? 'No closed or open hats were found, so hats share one column and the bottom row is all percussion.'
                    : 'Closed and open hats each get their own column.'}
              </p>
              <p className='text-sm text-text-muted-dark pt-2 leading-relaxed'>
                Samples keep the format of the files you dropped. Nothing is converted
                to a fixed bit depth or sample rate.
              </p>
            </div>
          </div>

          {error && (
            <div className='mt-6 text-sm text-red-400 border border-red-900 bg-red-950/30 rounded px-3 py-2'>
              {error}
            </div>
          )}
          {notice && (
            <div className='mt-6 text-sm text-warning-amber border border-warning-border bg-warning-bg/40 rounded px-3 py-2'>
              {notice}
            </div>
          )}

          <div className='mt-auto pt-6'>
            {isExporting && exportProgress && exportProgress.total > 1 && (
              <div className='text-sm text-text-muted uppercase tracking-wider mb-2 text-center'>
                Kit {Math.min(exportProgress.done + 1, exportProgress.total)} of {exportProgress.total}
              </div>
            )}
            <button
              onClick={exportKit}
              disabled={isEmpty || isExporting}
              className='w-full py-3.5 bg-white text-black font-bold uppercase text-sm tracking-[0.2em] rounded flex items-center justify-center gap-2 hover:bg-text-bright transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer'
            >
              {isExporting && <Loader2 className='w-4 h-4 animate-spin' />}
              {isExporting ? 'Building Bundle…' : 'Export To Move'}
            </button>
          </div>
        </aside>
      </main>

      <footer className='bg-surface-header border-t border-border-dark px-8 py-2.5 flex justify-between items-center text-sm text-text-muted-dark uppercase tracking-widest shrink-0'>
        <div>Kit Creator for Ableton Move</div>
        <div>{sourceFolders.length > 0 ? `${sourceFolders.length} folder(s) loaded` : 'Waiting for samples'}</div>
      </footer>

      {isHelpOpen && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 overflow-y-auto'>
          <div className='bg-surface-modal border border-border-main rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden'>
            {/* Modal Header */}
            <div className='flex items-center justify-between px-6 sm:px-8 py-5 border-b border-border-dark bg-surface-modal-header shrink-0'>
              <div className='flex items-center gap-3'>
                <HelpCircle size={24} className='text-accent-yellow' />
                <h2 className='text-base sm:text-lg font-bold uppercase tracking-widest text-white'>Kit Creator for Ableton Move — User Manual</h2>
              </div>
              <button
                onClick={() => setIsHelpOpen(false)}
                className='text-text-muted hover:text-white p-1.5 rounded-lg hover:bg-surface-btn-hover transition-colors cursor-pointer'
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
                  Kit Creator for Ableton Move automatically turns your drum sample collections into hardware-ready Ableton Move preset bundles (<code className='bg-black/60 px-2 py-0.5 rounded text-accent-yellow font-mono text-sm'>.ablpresetbundle</code>). Drop sample folders, customize pad mappings, and export directly to your hardware.
                </p>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>2. Adding & Scanning Sample Folders</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li><strong className='text-white'>Drag & Drop:</strong> Drag any sample folder directly onto the app window.</li>
                  <li><strong className='text-white'>Supported Formats:</strong> Accepts uncompressed <code className='text-white font-mono text-sm bg-black/60 px-1.5 py-0.5 rounded'>.wav</code> and <code className='text-white font-mono text-sm bg-black/60 px-1.5 py-0.5 rounded'>.aiff</code> audio files.</li>
                  <li><strong className='text-white'>Loop Filtering:</strong> Audio loops (detected by tempo or loop keywords) are automatically excluded from drum kit generation.</li>
                  <li><strong className='text-white'>Duplicate Protection:</strong> Folders already present in your list are automatically skipped.</li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>3. 4×4 Pad Grid & Controls</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li><strong className='text-white'>Hardware Note Mapping:</strong> Pad 1 (bottom-left) to Pad 16 (top-right) map to MIDI notes 36–51, matching Ableton Move hardware.</li>
                  <li><strong className='text-white'>Keyboard Hotkeys:</strong> Play pads instantly with row keys:
                    <div className='grid grid-cols-4 gap-1.5 max-w-sm text-sm font-mono text-accent-yellow mt-2 bg-surface-pad p-3 rounded-lg border border-border-main text-center font-bold'>
                      <div>1 2 3 4</div>
                      <div>Q W E R</div>
                      <div>A S D F</div>
                      <div>Z X C V</div>
                    </div>
                  </li>
                  <li><strong className='text-white'>Choke Groups:</strong> Closed & Open Hats automatically cut each other (Choke 1). Crashes cut each other (Choke 2).</li>
                  <li><strong className='text-white'>Split Bottom Bar:</strong> Click the left side (<code className='text-accent-yellow font-mono'>Lock</code>) to hold a sample across re-rolls. Click the right side (<code className='text-accent-yellow font-mono'>Refresh</code>) to randomize only that single pad.</li>
                  <li><strong className='text-white'>Exclude Sample:</strong> Click the ban icon in the sample name row to exclude a sample from future kit rolls.</li>
                </ul>
              </section>

              <section className='space-y-2.5'>
                <h3 className='text-sm sm:text-base font-bold uppercase tracking-wider text-accent-yellow'>4. Presets & Batch Exporting</h3>
                <ul className='list-disc pl-6 space-y-2 text-text-light'>
                  <li><strong className='text-white'>Preset Naming:</strong> Kit names combine a folder prefix (e.g. <code className='text-white font-mono text-sm bg-black/60 px-1.5 py-0.5 rounded'>MKIT</code>) and a random suffix (e.g. <code className='text-white font-mono text-sm bg-black/60 px-1.5 py-0.5 rounded'>Vibe</code>). Custom typed names are preserved.</li>
                  <li><strong className='text-white'>Silence Trimming:</strong> Trims leading and trailing silence (&lt; -60 dBFS) while keeping exact bit depth and sample rate.</li>
                  <li><strong className='text-white'>Batch Export:</strong> Export up to 10 distinct randomized kits at once in a single zip archive.</li>
                  <li><strong className='text-white'>Device Transfer:</strong> Copy exported <code className='text-white font-mono text-sm bg-black/60 px-1.5 py-0.5 rounded'>.ablpresetbundle</code> folders into your Ableton Move hardware preset library.</li>
                </ul>
              </section>
            </div>

            {/* Modal Footer */}
            <div className='px-6 sm:px-8 py-4 border-t border-border-dark bg-surface-modal-header flex justify-end shrink-0'>
              <button
                onClick={() => setIsHelpOpen(false)}
                className='px-6 py-2.5 bg-accent-yellow text-black font-bold uppercase text-sm tracking-wider rounded-lg hover:bg-white transition-colors cursor-pointer'
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
