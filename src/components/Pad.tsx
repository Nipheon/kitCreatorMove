import { Ban, Lock, RefreshCw, Unlock, Loader2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { categoryAccent } from '../padLayout';
import { Sample } from '../types';

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
  onReroll?: (index: number) => void;
  /**
   * Bumped by App when this pad's Shuffle is pressed. A changing value means "play
   * this pad now" — it does not depend on the sample changing, which is what the old
   * shouldPlayOnNextSample ref got wrong.
   */
  auditionToken?: number;
  isSpinning?: boolean;
}

export const Pad: React.FC<PadProps> = ({
  index, sample, expectedCategory, chokeGroup, isLocked, onToggleLock, onExclude, onReroll,
  auditionToken = 0, isSpinning = false
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!sample) {
      audioRef.current = null;
      return;
    }

    const audio = new Audio(sample.url);
    audio.preload = 'auto';

    const handleEnded = () => setIsPlaying(false);
    const handlePause = () => setIsPlaying(false);
    const handleError = (e: Event) => {
      console.error('Audio error:', e);
      setIsPlaying(false);
    };
    /**
     * Preview scheduling waits on this. A pad that never buffers simply never reports,
     * and App's ceiling timer starts the sequence anyway.
     */
    const sampleId = sample.id;
    const announceReady = () => {
      window.dispatchEvent(
        new CustomEvent<PadReadyDetail>('pad-ready', { detail: { index, sampleId } })
      );
    };

    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);
    audio.addEventListener('canplaythrough', announceReady);

    audio.load();
    audioRef.current = audio;
    // A blob already decoded for an earlier kit can be ready before canplaythrough fires.
    if (audio.readyState >= 3) announceReady();

    return () => {
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('canplaythrough', announceReady);
      audio.pause();
      audioRef.current = null;
      setIsPlaying(false);
    };
  }, [sample, chokeGroup, index]);

  useEffect(() => {
    const onStopAll = () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setIsPlaying(false);
    };
    window.addEventListener('stop-all-audio', onStopAll);
    return () => window.removeEventListener('stop-all-audio', onStopAll);
  }, []);

  useEffect(() => {
    const onChoke = (e: Event) => {
      const { group, sourceIndex } = (e as CustomEvent<ChokeDetail>).detail;
      if (chokeGroup && group === chokeGroup && sourceIndex !== index && audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        setIsPlaying(false);
      }
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
    if (!auditionToken || !audioRef.current) return;

    if (chokeGroup) {
      window.dispatchEvent(
        new CustomEvent<ChokeDetail>('choke', { detail: { group: chokeGroup, sourceIndex: index } })
      );
    }
    audioRef.current.currentTime = 0;
    audioRef.current.play().catch(err => console.error('Audio playback error:', err));
    setIsPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditionToken]);

  const handlePlay = React.useCallback(async () => {
    if (!audioRef.current) return;

    if (chokeGroup) {
      window.dispatchEvent(
        new CustomEvent<ChokeDetail>('choke', { detail: { group: chokeGroup, sourceIndex: index } })
      );
    }
    const audio = audioRef.current;
    audio.currentTime = 0;
    setIsPlaying(true);
    try {
      await audio.play();
      await firstAudibleProgress(audio);
      window.dispatchEvent(new CustomEvent<number>('pad-started', { detail: index }));
    } catch (error) {
      console.error('Audio playback error:', error);
      setIsPlaying(false);
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlePlay();
    }
  };

  const hotkey = PAD_HOTKEYS[index];

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

  // A div rather than a button: the lock, reroll, and exclude controls are buttons themselves,
  // and interactive elements cannot be nested inside a button.
  return (
    <div
      role="button"
      tabIndex={sample ? 0 : -1}
      aria-disabled={!sample}
      aria-label={sample ? `Play ${sample.name}` : `Pad ${index + 1}, empty`}
      onClick={sample ? handlePlay : undefined}
      onKeyDown={sample ? handleKeyDown : undefined}
      style={padStyle}
      className={`pad-tile group relative overflow-hidden w-full h-full min-h-0 bg-surface-pad border rounded-lg p-3 sm:p-4 flex flex-col justify-between transition-all duration-100 ease-out text-left ${
        sample
          ? isPlaying
            ? 'pad-tinted pad-glow border-[var(--category-accent)] scale-[0.98]'
            : 'pad-tinted border-border-main hover:border-[var(--category-accent)] cursor-pointer'
          : 'border-border-main opacity-50 cursor-not-allowed'
      }`}
    >
      <div className='flex w-full justify-between items-center'>
        <div className='flex items-center gap-1 sm:gap-1.5 shrink-0 min-w-0'>
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
        <div className={`w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full shrink-0 transition-all ${isPlaying ? 'bg-[var(--category-accent)] pad-dot-glow scale-110' : 'border border-border-light'}`}></div>
      </div>

      <div className='pad-body w-full mt-auto mb-8 sm:mb-9'>
        <div className='pad-category w-full text-sm uppercase tracking-wider font-medium mb-0.5'>
          {sample ? sample.category : expectedCategory}
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
          <div className='flex items-center gap-1 shrink-0'>
            {sample && onExclude && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  onExclude(sample.id, index);
                }}
                className='text-text-subtle hover:text-danger-text transition-colors p-1'
                title='Exclude sample'
                aria-label={`Exclude ${sample.name}`}
              >
                <Ban size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Split Bottom Bar: 50% Lock + 50% Shuffle */}
      <div className='pad-actions absolute bottom-0 left-0 right-0 h-8 sm:h-8.5 flex items-stretch border-t border-border-bar bg-surface-header z-10'>
        <button
          type='button'
          disabled={!sample}
          onClick={(e) => {
            e.stopPropagation();
            onToggleLock();
          }}
          aria-pressed={isLocked}
          aria-label={isLocked ? `Unlock pad ${index + 1}` : `Lock pad ${index + 1}`}
          className={`w-1/2 flex items-center justify-center gap-1.5 transition-colors ${
            !sample
              ? 'text-border-main cursor-not-allowed'
              : isLocked
                ? 'pad-lock-active font-semibold cursor-pointer'
                : 'text-text-subtle hover:text-text-light hover:bg-surface-hover cursor-pointer'
          }`}
        >
          {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
          <span className='pad-action-label text-pad-action uppercase tracking-wider font-semibold'>
            {isLocked ? 'Locked' : 'Lock'}
          </span>
        </button>

        <button
          type='button'
          disabled={!sample || isLocked || !onReroll}
          onClick={(e) => {
            e.stopPropagation();
            if (onReroll) onReroll(index);
          }}
          className={`w-1/2 border-l border-border-bar flex items-center justify-center gap-1.5 transition-colors ${
            !sample || isLocked || !onReroll
              ? 'text-border-main cursor-not-allowed'
              : 'pad-shuffle text-text-medium hover:bg-surface-hover cursor-pointer'
          }`}
          title='Shuffle sample on this pad'
          aria-label={`Shuffle sample on pad ${index + 1}`}
        >
          <RefreshCw size={14} />
          <span className='pad-action-label text-pad-action uppercase tracking-wider font-semibold'>
            Shuffle
          </span>
        </button>
      </div>
    </div>
  );
};
