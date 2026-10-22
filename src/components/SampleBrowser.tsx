import { Ban, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { categoryAccent, poolCategoryFor } from '../padLayout';
import { Category, Sample } from '../types';
import { browserCells, buildBrowserSections } from '../utils/browserGroups';
import { KitOptions } from '../utils/kitGenerator';
import { auditionUrl } from '../utils/sampleUrl';

const SECTION_ACCENT: Record<string, Category> = {
  kick: 'Kick', snare: 'Snare', clap: 'Clap', hats: 'CHH', perc: 'Perc', other: 'Other'
};

const AUDIO_EXTENSION = /\.(wav|wave|aif|aiff|aifc|flac|mp3|ogg|m4a)$/i;

/** Why a sample that is not disabled by hand is still left out of kits, or null when it is usable. */
function otherReason(sample: Sample, { skipLoops = true, skipNonDrums = true, disabledTypes, disabledKinds }: KitOptions): string | null {
  if (skipLoops && sample.isLoop) return 'a loop (Skip loops is on)';
  if (skipNonDrums && sample.isNonDrum) return 'not a drum (Skip non-drums is on)';
  if (disabledTypes?.has(poolCategoryFor(sample))) return 'its type is switched off';
  if (disabledKinds?.has(sample.kind)) return 'its kind is switched off';
  if (sample.isDuplicate) return 'a duplicate of a sample already on a pad';
  return null;
}

interface Props {
  dialogRef: React.RefObject<HTMLDivElement | null>;
  /** Samples of the visible folders. */
  samples: Sample[];
  kitOptions: KitOptions;
  usableCount: number;
  onToggleExcluded: (sampleId: string) => void;
  onClose: () => void;
}

/**
 * Full-screen grid of every loaded sample, by type and kind, for taking samples out of (or back
 * into) kit generation. Cursor keys move and play, Space replays, X disables. The dialog owns
 * the keyboard: App's pad hotkeys are off while it is open.
 */
export function SampleBrowser({ dialogRef, samples, kitOptions, usableCount, onToggleExcluded, onClose }: Props) {
  const sections = useMemo(() => buildBrowserSections(samples), [samples]);
  const cells = useMemo(() => browserCells(sections), [sections]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const tileRefs = useRef(new Map<string, HTMLElement>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playToken = useRef(0);
  /** The tile showing play progress (a CSS variable set straight on the element: no re-render of thousands of tiles per frame). */
  const progressId = useRef<string | null>(null);
  const setProgress = (id: string | null, percent: number) =>
    id && tileRefs.current.get(id)?.style.setProperty('--progress', `${percent}%`);

  // Read through refs by the one keydown listener, so it never closes over stale state.
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const toggleRef = useRef(onToggleExcluded);
  toggleRef.current = onToggleExcluded;

  const play = (sample: Sample) => {
    const token = ++playToken.current;
    const audio = (audioRef.current ??= new Audio());
    audio.pause();
    setProgress(progressId.current, 0);
    progressId.current = sample.id;
    void auditionUrl(sample).then(url => {
      if (token !== playToken.current || !url) return;
      audio.src = url;
      audio.currentTime = 0;
      audio.play().catch(err => {
        if (err?.name !== 'AbortError') console.error('Audio playback error:', err);
      });
      // The bar fills with the share of the sample already played; it is cleared the moment the sample ends.
      const tick = () => {
        if (token !== playToken.current) return;
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setProgress(sample.id, Math.min(100, (audio.currentTime / audio.duration) * 100));
        }
        if (audio.ended) setProgress(sample.id, 0);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };
  const playRef = useRef(play);
  playRef.current = play;

  const select = (sample: Sample, andPlay = true) => {
    setSelectedId(sample.id);
    tileRefs.current.get(sample.id)?.scrollIntoView({ block: 'nearest' });
    if (andPlay) playRef.current(sample);
  };
  const selectRef = useRef(select);
  selectRef.current = select;

  // Silence on close.
  useEffect(() => () => {
    playToken.current++;
    audioRef.current?.pause();
  }, []);

  useEffect(() => {
    /** The cell one visual row above or below `index`, nearest in horizontal position. DOM order is reading order, so the search stays local. */
    const verticalNeighbour = (index: number, step: 1 | -1): number => {
      const list = cellsRef.current;
      const rectOf = (i: number) => tileRefs.current.get(list[i].id)?.getBoundingClientRect();
      const here = rectOf(index);
      if (!here) return index;
      const centre = here.left + here.width / 2;
      let i = index + step;
      while (i >= 0 && i < list.length && rectOf(i)?.top === here.top) i += step;
      if (i < 0 || i >= list.length) return index;
      const rowTop = rectOf(i)?.top;
      let best = i;
      let bestDistance = Infinity;
      for (; i >= 0 && i < list.length && rectOf(i)?.top === rowTop; i += step) {
        const r = rectOf(i)!;
        const distance = Math.abs(r.left + r.width / 2 - centre);
        if (distance < bestDistance) { best = i; bestDistance = distance; }
      }
      return best;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const list = cellsRef.current;
      if (list.length === 0) return;
      const current = list.findIndex(s => s.id === selectedRef.current);

      if (e.key === ' ') {
        e.preventDefault();
        if (!e.repeat && current >= 0) playRef.current(list[current]);
        return;
      }
      if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        if (!e.repeat && current >= 0) toggleRef.current(list[current].id);
        return;
      }

      let next = -1;
      if (e.key === 'ArrowRight') next = current < 0 ? 0 : Math.min(current + 1, list.length - 1);
      else if (e.key === 'ArrowLeft') next = current < 0 ? 0 : Math.max(current - 1, 0);
      else if (e.key === 'ArrowDown') next = current < 0 ? 0 : verticalNeighbour(current, 1);
      else if (e.key === 'ArrowUp') next = current < 0 ? 0 : verticalNeighbour(current, -1);
      if (next < 0) return;
      e.preventDefault();
      if (next !== current) selectRef.current(list[next]);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className='fixed inset-0 z-50 flex bg-overlay-strong backdrop-blur-md p-2 sm:p-4'>
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby='sample-browser-title'
        aria-activedescendant={selectedId ? `browser-${selectedId}` : undefined}
        tabIndex={-1}
        className='bg-surface-modal border border-border-main rounded-2xl w-full flex flex-col shadow-2xl overflow-hidden outline-none'
      >
        <div className='flex items-center justify-between gap-4 px-4 py-3 border-b border-border-dark bg-surface-modal-header shrink-0'>
          <h2 id='sample-browser-title' className='text-[17px] font-bold uppercase tracking-widest text-text-bright'>Sample Browser</h2>
          <span className='ml-auto text-[15px] text-text-muted uppercase font-medium'>
            {usableCount.toLocaleString()} / {samples.length.toLocaleString()} usable
          </span>
          <button
            type='button'
            onClick={onClose}
            className='text-text-muted hover:text-text-bright p-1.5 rounded-lg hover:bg-surface-btn-hover transition-colors cursor-pointer'
            aria-label='Close sample browser'
          >
            <X size={20} />
          </button>
        </div>

        <div role='listbox' aria-label='Samples' className='flex-1 overflow-y-auto px-4 py-3 space-y-4'>
          {sections.length === 0 && (
            <div className='text-[15px] text-text-subtle text-center mt-8'>No samples loaded</div>
          )}
          {sections.map(section => (
            <section
              key={section.key}
              style={{ '--category-accent': categoryAccent(SECTION_ACCENT[section.key]) } as React.CSSProperties}
              className='space-y-1.5'
              aria-label={section.label}
            >
              <h3 className='category-ink text-[15px] uppercase tracking-wider font-bold border-b border-border-dark pb-0.5'>
                {section.label}
              </h3>
              {section.rows.map(row => {
                // The pairs row draws a frame round each closed+open run.
                let offset = 0;
                const runs = row.groups
                  ? row.groups.map(size => row.samples.slice(offset, (offset += size)))
                  : [row.samples];
                return (
                  <div key={row.key} className='flex gap-2 items-start'>
                    <div className='w-16 shrink-0 pt-0.5 text-[13px] text-text-subtle uppercase font-medium'>{row.label}</div>
                    <div className='flex flex-wrap gap-1 min-w-0'>
                      {runs.map((run, runIndex) => (
                        <div
                          key={runIndex}
                          className={row.groups ? 'flex gap-0.5 rounded-md border border-border-main p-0.5' : 'contents'}
                        >
                          {run.map(sample => {
                            const disabled = !!sample.isExcluded;
                            const reason = disabled ? null : otherReason(sample, kitOptions);
                            const selected = sample.id === selectedId;
                            const label = sample.name.replace(AUDIO_EXTENSION, '');
                            return (
                              <div
                                key={sample.id}
                                id={`browser-${sample.id}`}
                                ref={el => {
                                  if (el) tileRefs.current.set(sample.id, el); else tileRefs.current.delete(sample.id);
                                }}
                                role='option'
                                aria-selected={selected}
                                aria-disabled={disabled}
                                title={`${sample.name}${disabled ? ' (disabled)' : reason ? ` (left out: ${reason})` : ''}`}
                                onClick={() => select(sample)}
                                className={`sample-tile group flex items-center w-32 h-6 rounded border text-[13px] cursor-pointer select-none ${
                                  selected
                                    ? 'border-accent-yellow bg-surface-hover text-text-bright'
                                    : 'border-border-dark bg-surface-pad text-text-light hover:bg-surface-hover'
                                } ${disabled ? 'opacity-45 line-through' : reason ? 'opacity-60 border-dashed' : ''}`}
                              >
                                <span className='truncate flex-1 min-w-0 pl-1.5'>{label}</span>
                                <span
                                  role='presentation'
                                  onClick={(e) => { e.stopPropagation(); onToggleExcluded(sample.id); }}
                                  title={disabled ? 'Use this sample again (X)' : 'Leave this sample out of every kit (X)'}
                                  className={`shrink-0 px-1 h-full flex items-center ${
                                    disabled ? 'text-danger-text' : 'text-text-dim group-hover:text-text-subtle hover:text-danger-text'
                                  }`}
                                >
                                  <Ban size={12} aria-hidden />
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        <div className='shrink-0 px-4 py-2 border-t border-border-dark bg-surface-modal-header text-[13px] text-text-subtle flex flex-wrap gap-x-4 gap-y-1'>
          <span>←↑↓→ move and play</span>
          <span>Space play again</span>
          <span>X disable / enable</span>
          <span>Esc close</span>
          <span className='sm:ml-auto'>Struck through: disabled · dashed: left out by a filter or duplicate</span>
        </div>
      </div>
    </div>
  );
}
