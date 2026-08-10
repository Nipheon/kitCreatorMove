import { FolderUp, Loader2, RefreshCw, Eye, EyeOff } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pad } from './components/Pad';
import { chokeGroupFor, chooseLayout, DISPLAY_INDICES, PAD_COUNT } from './padLayout';
import { Sample, SourceFolder } from './types';
import { exportBatchKits, exportKitZip, kitSizeBytes } from './utils/exporter';
import { categorizeSample, getFilesFromDataTransfer, looksLikeLoop } from './utils/fileReader';
import { emptyKit, generateRandomKit, isUsableSample, KitResult } from './utils/kitGenerator';
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

  // dragenter/dragleave also fire for every child element, so the overlay is driven
  // by a depth counter rather than by the raw events.
  const dragDepth = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  const samples = useMemo(() => enabledSamples(sourceFolders), [sourceFolders]);
  const kit = kitResult.kit;

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.repeat) return;

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

      const newFolders: SourceFolder[] = folderData
        .map(folder => {
          return {
            id: newId('folder'),
            name: folder.name || 'Dropped Files',
            isEnabled: true,
            samples: folder.files.map<Sample>(({ file, path }) => ({
              id: newId('sample'),
              file,
              name: file.name,
              // The containing folder is the fallback when the filename says nothing.
              category: categorizeSample(file.name, path),
              isLoop: looksLikeLoop(file.name, path),
              url: URL.createObjectURL(file)
            }))
          };
        })
        .filter(folder => folder.samples.length > 0);

      if (newFolders.length === 0) {
        setError('No .wav or .aiff files found in what you dropped. Move plays those two formats only.');
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

  const handleExcludeSample = (sampleId: string) => {
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
  };

  const randomizeKit = () => {
    if (samples.length > 0) {
      setKitResult(generateRandomKit(samples, lockedFrom(kit), kitOptions));
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
      className="flex flex-col h-screen w-screen bg-[#090909] text-[#E0E0E0] font-sans overflow-hidden"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {(isDragging || isLoading) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090909]/90 backdrop-blur-sm border-2 border-dashed border-[#00FFFC] m-4 rounded-xl">
          <div className="text-center">
            {isLoading ? (
              <>
                <Loader2 className="w-16 h-16 text-[#00FFFC] mx-auto mb-4 animate-spin" />
                <h2 className="text-2xl font-bold uppercase tracking-widest">Scanning</h2>
                <p className="text-[#888] mt-2 text-sm uppercase tracking-wider">Reading audio files…</p>
              </>
            ) : (
              <>
                <FolderUp className="w-16 h-16 text-[#00FFFC] mx-auto mb-4 animate-pulse" />
                <h2 className="text-2xl font-bold uppercase tracking-widest">Drop Sample Folders Here</h2>
                <p className="text-[#888] mt-2 text-sm uppercase tracking-wider">.wav and .aiff files</p>
              </>
            )}
          </div>
        </div>
      )}

      <header className='flex items-center justify-between px-8 py-4 border-b border-[#222] bg-[#111] shrink-0'>
        <div className='flex items-center gap-3'>
          <div className='w-8 h-8 bg-[#00FFFC] rounded-sm flex items-center justify-center'>
            <div className='w-4 h-4 border-2 border-black rotate-45'></div>
          </div>
          <h1 className='text-lg font-bold tracking-widest uppercase'>Move Kit Builder</h1>
        </div>
        <div className='text-xs text-[#666] uppercase tracking-wider'>
          Exports an .ablpresetbundle — copy it to your Move
        </div>
      </header>

      <main className='flex flex-col lg:flex-row flex-1 overflow-y-auto lg:overflow-hidden'>
        <aside className='w-full lg:w-72 bg-[#0E0E0E] border-b lg:border-b-0 lg:border-r border-[#222] p-6 flex flex-col shrink-0 lg:overflow-y-auto'>
          <div className='mb-8'>
            <h2 className='text-[10px] uppercase tracking-[0.2em] text-[#666] mb-4'>Source Folders</h2>
            <div className='border-2 border-dashed border-[#333] rounded-lg p-4 text-center mb-4'>
              <div className='text-2xl mb-2 text-[#444]'>+</div>
              <p className='text-[11px] text-[#888]'>Drag sample folders anywhere on this window</p>
            </div>
            {sourceFolders.map(folder => (
              <div key={folder.id} className={`space-y-2 mt-2 ${folder.isEnabled === false ? 'opacity-50' : ''}`}>
                <div className='bg-[#1A1A1A] px-3 py-2 rounded flex items-center justify-between group'>
                  <div className='flex items-center gap-2 overflow-hidden flex-1'>
                    <button
                      onClick={() => toggleFolder(folder.id)}
                      className='text-[#555] hover:text-[#E0E0E0] transition-colors shrink-0'
                      title={folder.isEnabled === false ? 'Enable folder' : 'Disable folder'}
                      aria-label={folder.isEnabled === false ? `Enable ${folder.name}` : `Disable ${folder.name}`}
                    >
                      {folder.isEnabled === false ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <span className='text-xs truncate text-[#E0E0E0] flex-1'>{folder.name}</span>
                    <span className='text-[10px] text-[#888] shrink-0 font-medium bg-[#111] px-1.5 py-0.5 rounded'>{folder.samples.length}</span>
                  </div>
                  <button
                    onClick={() => removeFolder(folder.id)}
                    className='text-[10px] text-[#555] group-hover:text-red-400 ml-2'
                    aria-label={`Remove ${folder.name}`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            {sourceFolders.length === 0 && (
              <div className='text-xs text-[#555] text-center mt-4'>No folders loaded</div>
            )}
          </div>
          <div className='mt-auto'>
            <div className='p-4 bg-[#151515] rounded-lg border border-[#222]'>
              <div className='flex justify-between text-[10px] mb-2 text-[#888] uppercase'>
                <span>Usable Samples</span>
                <span>{usableCount.toLocaleString()} / {samples.length.toLocaleString()}</span>
              </div>
              <div className='w-full bg-[#333] h-1 rounded-full overflow-hidden'>
                <div className='bg-[#00FFFC] h-full transition-all' style={{ width: samples.length > 0 ? `${Math.round((usableCount / samples.length) * 100)}%` : '0%' }}></div>
              </div>
            </div>
          </div>
        </aside>

        <section className='flex-1 w-full bg-[#090909] flex flex-col items-center justify-center p-4 sm:p-8 shrink-0 lg:overflow-y-auto min-h-[60vh]'>
          <div className='grid grid-cols-4 gap-2 sm:gap-3 mb-8 w-full max-w-lg'>
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
              />
            ))}
          </div>

          {(kitResult.substituted.length > 0 || kitResult.empty.length > 0) && (
            <div className='mb-6 text-[11px] text-[#B8860B] uppercase tracking-wider text-center space-y-1'>
              {kitResult.substituted.length > 0 && (
                <div>{kitResult.substituted.length} pad(s) filled from a different category</div>
              )}
              {kitResult.empty.length > 0 && (
                <div>{kitResult.empty.length} pad(s) left empty — not enough samples</div>
              )}
            </div>
          )}

          <button
            onClick={randomizeKit}
            className='px-8 py-3 bg-[#00FFFC] text-black font-bold uppercase text-xs tracking-widest rounded-full hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
            disabled={usableCount === 0}
          >
            Generate Random Kit
          </button>
        </section>

        <aside className='w-full lg:w-80 bg-[#0E0E0E] border-t lg:border-t-0 lg:border-l border-[#222] p-6 flex flex-col shrink-0 lg:overflow-y-auto'>
          <h2 className='text-[10px] uppercase tracking-[0.2em] text-[#666] mb-6'>Preset Settings</h2>
          <div className='space-y-6'>
            <div className='space-y-2'>
              <div className='flex justify-between items-center'>
                <label className='text-[10px] text-[#888] uppercase'>Preset Name</label>
                <button
                  onClick={() => setKitSuffix(generateKitName('').suffix)}
                  className='text-[10px] text-[#00FFFC] hover:text-white transition-colors flex items-center gap-1'
                >
                  <RefreshCw size={10} /> Randomize Suffix
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
                  className='w-1/2 bg-[#1A1A1A] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#00FFFC] outline-none text-[#E0E0E0] uppercase'
                  placeholder='PREFIX'
                  maxLength={12}
                  aria-label='Preset name prefix'
                />
                <span className='text-[#555]'>-</span>
                <input
                  type='text'
                  value={kitSuffix}
                  onChange={(e) => setKitSuffix(e.target.value)}
                  className='w-1/2 bg-[#1A1A1A] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#00FFFC] outline-none text-[#E0E0E0]'
                  placeholder='SUFFIX'
                  maxLength={12}
                  aria-label='Preset name suffix'
                />
              </div>
            </div>

            <div className='space-y-2'>
              <div className='flex justify-between items-center'>
                <label htmlFor='batch-size' className='text-[10px] text-[#888] uppercase'>Batch Export Amount</label>
                <span className='text-[10px] text-[#00FFFC] font-bold'>{batchSize} Kit{batchSize !== 1 ? 's' : ''}</span>
              </div>
              <input
                id='batch-size'
                type='range'
                min='1'
                max='10'
                value={batchSize}
                onChange={(e) => setBatchSize(parseInt(e.target.value))}
                className='w-full accent-[#00FFFC]'
              />
              <p className='text-[9px] text-[#555]'>
                Export multiple random kits in one zip. Locked pads remain the same across all.
              </p>
            </div>

            <div className='space-y-2'>
              <label className='flex items-center gap-2 text-[10px] text-[#888] uppercase cursor-pointer'>
                <input
                  type='checkbox'
                  checked={skipLoops}
                  onChange={(e) => toggleSkipLoops(e.target.checked)}
                  className='accent-[#00FFFC]'
                />
                Skip loops{loopCount > 0 ? ` (${loopCount} found)` : ''}
              </label>
              <p className='text-[9px] text-[#555]'>
                Leaves out files whose name or folder marks them as a loop — "loop",
                a bar count, or a tempo like 128bpm.
              </p>
            </div>

            <div className='space-y-2'>
              <label className='flex items-center gap-2 text-[10px] text-[#888] uppercase cursor-pointer'>
                <input
                  type='checkbox'
                  checked={trimSilence}
                  onChange={(e) => setTrimSilence(e.target.checked)}
                  className='accent-[#00FFFC]'
                />
                Trim leading silence
              </label>
              <p className='text-[9px] text-[#555]'>
                Re-encodes trimmed samples at their original sample rate and bit depth.
                Turn off to copy every sample byte-for-byte.
              </p>
            </div>

            <div className='pt-6 border-t border-[#222] space-y-1'>
              <div className='flex justify-between text-xs'><span>Layout</span><span className='text-[#00FFFC]'>{kitResult.layout.label}</span></div>
              <div className='flex justify-between text-xs'><span>Filled Pads</span><span className='text-[#00FFFC]'>{filledPads} / {PAD_COUNT}</span></div>
              <div className='flex justify-between text-xs'><span>Source Audio</span><span className='text-[#00FFFC]'>{formatMb(kitSizeBytes(kit))}</span></div>
              <p className='text-[10px] text-[#555] pt-3 leading-relaxed'>
                {kitResult.layout.id === 'minimal-layout'
                  ? 'Only generic hats, kicks and snares were found, so each row is Kick, Snare, Snare, Hat.'
                  : kitResult.layout.id === 'generic-hats'
                  ? 'No closed or open hats were found, so hats share one column and the bottom row is all percussion.'
                  : 'Closed and open hats each get their own column.'}
              </p>
              <p className='text-[10px] text-[#555] pt-2 leading-relaxed'>
                Samples keep the format of the files you dropped. Nothing is converted
                to a fixed bit depth or sample rate.
              </p>
            </div>
          </div>

          {error && (
            <div className='mt-6 text-[11px] text-red-400 border border-red-900 bg-red-950/30 rounded px-3 py-2'>
              {error}
            </div>
          )}
          {notice && (
            <div className='mt-6 text-[11px] text-[#B8860B] border border-[#5a4404] bg-[#2a2004]/40 rounded px-3 py-2'>
              {notice}
            </div>
          )}

          <div className='mt-auto pt-6'>
            {isExporting && exportProgress && exportProgress.total > 1 && (
              <div className='text-[10px] text-[#888] uppercase tracking-wider mb-2 text-center'>
                Kit {Math.min(exportProgress.done + 1, exportProgress.total)} of {exportProgress.total}
              </div>
            )}
            <button
              onClick={exportKit}
              disabled={isEmpty || isExporting}
              className='w-full py-4 bg-white text-black font-bold uppercase text-xs tracking-[0.2em] rounded flex items-center justify-center gap-2 hover:bg-[#E0E0E0] transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
            >
              {isExporting && <Loader2 className='w-4 h-4 animate-spin' />}
              {isExporting ? 'Building Bundle…' : 'Export To Move'}
            </button>
          </div>
        </aside>
      </main>

      <footer className='bg-[#111] border-t border-[#222] px-8 py-2 flex justify-between items-center text-[9px] text-[#555] uppercase tracking-widest shrink-0'>
        <div>Move Kit Builder</div>
        <div>{sourceFolders.length > 0 ? `${sourceFolders.length} folder(s) loaded` : 'Waiting for samples'}</div>
      </footer>
    </div>
  );
}
