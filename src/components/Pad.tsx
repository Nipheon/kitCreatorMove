import { Ban, Lock, Pencil, RefreshCw, Unlock, Loader2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { categoryAccent, padLabel } from '../padLayout';
import { Sample } from '../types';
import { defaultKind, KIND_LABELS } from '../utils/kinds';
import { fadeOutAll, triggerFrom, Voice } from '../utils/audioEngine';
import { auditionUrl, needsAuditionConversion, sampleUrl } from '../utils/sampleUrl';

interface ChokeDetail {
  group: number;
  sourceIndex: number;
}

interface PadReadyDetail {
  index: number;
  sampleId: string;
}

/**
 * Resolves on the first animation frame where the element has actually advanced past
 * zero — the closest cheap proxy for sound leaving the speakers.
 *
 * `play()` resolving means playback was *initiated*, not that anything is audible: the
 * spec fires `playing` and resolves the pending play promises in one task, so both land
 * before the output stream has produced a sample. Preview spacing is measured from
 * `pad-started`, so dispatching that on play() resolution let a pad whose onset lagged
 * pull the next pad in too early. `timeupdate` is throttled around 250ms — the same
 * order as the lag being corrected — so this polls frames instead.
 *
 * Capped: a pad that never progresses must not stall the sequence.
 */
const ONSET_POLL_TIMEOUT_MS = 400;

const firstAudibleProgress = (audio: HTMLAudioElement) =>
  new Promise<void>(resolve => {
    if (audio.currentTime > 0) {
      resolve();
      return;
    }
    const deadline = performance.now() + ONSET_POLL_TIMEOUT_MS;
    const poll = () => {
      if (audio.paused || audio.currentTime > 0 || performance.now() >= deadline) {
        resolve();
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });

const PAD_HOTKEYS: Record<number, string> = {
  12: '1', 13: '2', 14: '3', 15: '4',
  8: 'Q', 9: 'W', 10: 'E', 11: 'R',
  4: 'A', 5: 'S', 6: 'D', 7: 'F',
  0: 'Z', 1: 'X', 2: 'C', 3: 'V'
};

interface PadProps {
  index: number;
  sample: Sample | null;
  expectedCategory: string;
  chokeGroup: number | null;
  isLocked: boolean;
  onToggleLock: () => void;
  onExclude?: (id: string, index: number) => void;
  /** Opens the sample browser to pick this pad's sample; `opener` gets the focus back when it closes. */
  onEdit?: (index: number, opener: HTMLButtonElement) => void;
  onReroll?: (index: number) => void;
  /**
   * Bumped by App when this pad's Shuffle is pressed. A changing value means "play
   * this pad now" — it does not depend on the sample changing, which is what the old
   * shouldPlayOnNextSample ref got wrong.
   */
  auditionToken?: number;
  isSpinning?: boolean;
  /** A kit is being generated: lock, shuffle and exclude are off until it lands. */
  isBusy?: boolean;
}

export const Pad: React.FC<PadProps> = ({
  index, sample, expectedCategory, chokeGroup, isLocked, onToggleLock, onExclude, onEdit, onReroll,
  auditionToken = 0, isSpinning = false, isBusy = false
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  /**
   * Two voices per pad, both buffered: a retrigger plays the idle one while the other fades out
   * (`utils/audioEngine.ts`), so the same pad can overlap itself for 20 ms instead of clicking.
   */
  const voicesRef = useRef<Voice[]>([]);

  useEffect(() => {
    if (!sample) {
      voicesRef.current = [];
      return;
    }

    // An AIFF has no src until its WAV is made (below); everything else plays the file itself.
    const converting = needsAuditionConversion(sample);
    const makeAudio = () => {
      const audio = new Audio(converting ? undefined : sampleUrl(sample));
      audio.preload = 'auto';
      return audio;
    };
    const audios = [makeAudio(), makeAudio()];
    const [audio] = audios;
    const voices = audios.map(a => new Voice(a));
    let cancelled = false;

    const refreshPlaying = () => setIsPlaying(voices.some(v => v.playing));
    voices.forEach(v => v.onChange(refreshPlaying));
    const handleError = (e: Event) => {
      console.error('Audio error:', e);
      setIsPlaying(false);
      announceReady(); // a pad that cannot load must not hold the preview back
    };
    /**
     * Preview scheduling waits on this. A pad that never buffers simply never reports,
     * and App's ceiling timer starts the sequence anyway. The first voice reports for the pad.
     */
    const sampleId = sample.id;
    const announceReady = () => {
      window.dispatchEvent(
        new CustomEvent<PadReadyDetail>('pad-ready', { detail: { index, sampleId } })
      );
    };

    audios.forEach(a => a.addEventListener('error', handleError));
    audio.addEventListener('canplaythrough', announceReady);

    voicesRef.current = voices;
    if (converting) {
      void auditionUrl(sample).then(url => {
        if (cancelled) return;
        if (url) {
          audios.forEach(a => { a.src = url; a.load(); });
        } else {
          announceReady(); // not convertible: report at once instead of waiting for App's ceiling timer
        }
      });
    } else {
      audios.forEach(a => a.load());
      // A blob already decoded for an earlier kit can be ready before canplaythrough fires.
      if (audio.readyState >= 3) announceReady();
    }

    return () => {
      cancelled = true;
      audios.forEach(a => a.removeEventListener('error', handleError));
      audio.removeEventListener('canplaythrough', announceReady);
      // A sounding voice fades out instead of being cut when its sample is replaced.
      voices.forEach(v => v.dispose());
      voicesRef.current = [];
      setIsPlaying(false);
    };
  }, [sample, chokeGroup, index]);

  useEffect(() => {
    const onStopAll = () => fadeOutAll(voicesRef.current);
    window.addEventListener('stop-all-audio', onStopAll);
    return () => window.removeEventListener('stop-all-audio', onStopAll);
  }, []);

  useEffect(() => {
    const onChoke = (e: Event) => {
      const { group, sourceIndex } = (e as CustomEvent<ChokeDetail>).detail;
      if (chokeGroup && group === chokeGroup && sourceIndex !== index) fadeOutAll(voicesRef.current);
    };
    window.addEventListener('choke', onChoke);
    return () => window.removeEventListener('choke', onChoke);
  }, [chokeGroup, index]);

  /**
   * Auditions this pad when Shuffle is pressed. Deliberately keyed on the token and
   * NOT on `sample`: a shuffle can legitimately land on the same sample, and the old
   * ref-based version then never fired — leaving itself armed, so the next full
   * generate played every armed pad at once.
   *
   * This must stay declared below the effect that builds the audio element. React runs
   * effects in declaration order within a commit, which is what guarantees the new
   * sample is loaded before we play it.
   */
  useEffect(() => {
    if (!auditionToken || voicesRef.current.length === 0) return;

    if (chokeGroup) {
      window.dispatchEvent(
        new CustomEvent<ChokeDetail>('choke', { detail: { group: chokeGroup, sourceIndex: index } })
      );
    }
    // An AIFF pad's play() is aborted when its converted WAV loads; the voice marks itself stopped.
    triggerFrom(voicesRef.current).play().catch(err => {
      if (err?.name !== 'AbortError') console.error('Audio playback error:', err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditionToken]);

  const handlePlay = React.useCallback(async () => {
    if (voicesRef.current.length === 0) return;

    if (chokeGroup) {
      window.dispatchEvent(
        new CustomEvent<ChokeDetail>('choke', { detail: { group: chokeGroup, sourceIndex: index } })
      );
    }
    const voice = triggerFrom(voicesRef.current);
    try {
      await voice.play();
      await firstAudibleProgress(voice.audio);
      window.dispatchEvent(new CustomEvent<number>('pad-started', { detail: index }));
    } catch (error) {
      console.error('Audio playback error:', error);
    }
  }, [chokeGroup, index]);

  useEffect(() => {
    const onPlayPad = (e: Event) => {
      if ((e as CustomEvent<number>).detail === index) {
        handlePlay();
      }
    };
    window.addEventListener('play-pad', onPlayPad);
    return () => window.removeEventListener('play-pad', onPlayPad);
  }, [index, handlePlay]);

  const hotkey = PAD_HOTKEYS[index];
  const label = padLabel(sample?.category ?? null, sample?.kind ?? null, expectedCategory);

  /**
   * The pad's colour, one hue per drum category. Set as a custom property on the root so
   * the tint, the border, the glow, the number and the two bottom-bar buttons all derive
   * from a single value — a Tailwind class assembled at runtime would compile to nothing.
   *
   * An empty pad still gets the colour of the role it advertises, so the grid reads as
   * the layout the library produced even before a kit is generated.
   */
  const padStyle = {
    '--category-accent': categoryAccent(sample ? sample.category : expectedCategory)
  } as React.CSSProperties;

  // The tile is a plain wrapper. The play surface is a real button laid over it, and the
  // exclude/lock/shuffle buttons are its siblings, so no interactive element is nested in
  // another. The visible content sits above the play button with pointer-events off, so
  // clicks fall through to it; the control buttons switch pointer-events back on.
  return (
    <div
      style={padStyle}
      className={`pad-tile group relative overflow-hidden w-full h-full min-h-0 bg-surface-pad border rounded-lg p-3 sm:p-4 flex flex-col justify-between transition-all duration-100 ease-out text-left ${
        sample
          ? isPlaying
            ? 'pad-tinted pad-glow border-[var(--category-accent)] scale-[0.98]'
            : 'pad-tinted border-border-main hover:border-[var(--category-accent)]'
          : 'border-border-main opacity-50'
      }`}
    >
      <button
        type='button'
        data-space-generates
        disabled={!sample}
        onClick={handlePlay}
        aria-label={sample ? `Play ${sample.name}${label.toLowerCase() !== sample.category.toLowerCase() ? `, ${label.toLowerCase()}` : ''}` : `Pad ${index + 1}, empty`}
        className={`absolute inset-0 w-full h-full focus-visible:outline-2 focus-visible:-outline-offset-2 ${
          sample ? 'cursor-pointer' : 'cursor-not-allowed'
        }`}
      />
      <div className='pad-header pointer-events-none relative flex w-full justify-between items-center'>
        <div className='pad-header-group flex items-center gap-1 sm:gap-1.5 shrink-0 min-w-0'>
          <span className='pad-number category-ink text-sm font-bold shrink-0'>
            {(index + 1).toString().padStart(2, '0')}
          </span>
          {hotkey && (
            <span className='pad-hotkey text-xs font-mono text-text-muted bg-surface-header px-1 py-0.5 rounded border border-border-main shrink-0' title={`Keyboard key [${hotkey}]`}>
              {hotkey}
            </span>
          )}
          {chokeGroup && (
            <span
              className='pad-choke-badge text-[10px] sm:text-xs font-medium uppercase tracking-wider border px-1 py-0.5 rounded-sm shrink-0 whitespace-nowrap'
              title={`Choke group ${chokeGroup} — only one pad in this group sounds at a time`}
            >
              <span className='pad-choke-word'>Choke </span>{chokeGroup}
            </span>
          )}
        </div>
        <div className={`pad-indicator w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full shrink-0 transition-all ${isPlaying ? 'bg-[var(--category-accent)] pad-dot-glow scale-110' : 'border border-border-light'}`}></div>
      </div>

      <div className='pad-body pointer-events-none relative w-full mt-auto mb-8 sm:mb-9'>
        <div
          className='pad-category w-full text-sm uppercase tracking-wider font-medium mb-0.5 truncate'
          title={sample ? `${sample.category}${sample.kind !== defaultKind(sample.category) ? `, ${KIND_LABELS[sample.kind].toLowerCase()}` : ''}` : undefined}
        >
          {label}
        </div>
        <div className='w-full flex items-center justify-between gap-1'>
          <div className='pad-name text-sm truncate font-medium text-text-bright pr-1 flex items-center gap-1.5'>
            {isSpinning ? (
              <span className='category-ink flex items-center gap-1 animate-pulse'>
                <Loader2 className='category-ink w-3.5 h-3.5 animate-spin shrink-0' />
                <span className='text-text-muted text-xs uppercase font-mono tracking-wider'>Rolling</span>
              </span>
            ) : (
              sample ? sample.name : 'Empty'
            )}
          </div>
          <div className='flex items-center gap-1 shrink-0 pointer-events-auto'>
            {sample && onExclude && (
              <button
                type='button'
                onClick={() => onExclude(sample.id, index)}
                disabled={isBusy}
                className='text-text-subtle hover:text-danger-text transition-colors p-1 disabled:opacity-40 disabled:cursor-not-allowed'
                title='Exclude sample'
                aria-label={`Exclude ${sample.name}`}
              >
                <Ban size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom bar, icons only, a third each: Edit, Shuffle, Lock. Names live in aria-label and title. */}
      <div className='pad-actions absolute bottom-0 left-0 right-0 h-8 sm:h-8.5 flex items-stretch border-t border-border-bar bg-surface-header z-10'>
        <button
          type='button'
          disabled={!onEdit || isBusy}
          onClick={(e) => onEdit?.(index, e.currentTarget)}
          className={`w-1/3 flex items-center justify-center transition-colors ${
            !onEdit || isBusy
              ? 'text-border-main cursor-not-allowed'
              : 'pad-shuffle text-text-medium hover:bg-surface-hover cursor-pointer'
          }`}
          title='Choose a sample for this pad'
          aria-label={`Edit pad ${index + 1}`}
        >
          <Pencil size={14} />
        </button>

        <button
          type='button'
          disabled={!sample || isLocked || !onReroll || isBusy}
          onClick={() => onReroll?.(index)}
          className={`w-1/3 border-l border-border-bar flex items-center justify-center transition-colors ${
            !sample || isLocked || !onReroll || isBusy
              ? 'text-border-main cursor-not-allowed'
              : 'pad-shuffle text-text-medium hover:bg-surface-hover cursor-pointer'
          }`}
          title='Shuffle sample on this pad'
          aria-label={`Shuffle sample on pad ${index + 1}`}
        >
          <RefreshCw size={14} />
        </button>

        <button
          type='button'
          disabled={!sample || isBusy}
          onClick={onToggleLock}
          aria-pressed={isLocked}
          title={isLocked ? 'Unlock this pad' : 'Lock this pad: shuffle and new kits keep its sample'}
          aria-label={`Lock pad ${index + 1}`}
          className={`w-1/3 border-l border-border-bar flex items-center justify-center transition-colors ${
            !sample
              ? 'text-border-main cursor-not-allowed'
              : isLocked
                ? 'pad-lock-active cursor-pointer'
                : 'text-text-subtle hover:text-text-light hover:bg-surface-hover cursor-pointer'
          }`}
        >
          {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
      </div>
    </div>
  );
};
