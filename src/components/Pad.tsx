import { Ban, Lock, RefreshCw, Unlock } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { Sample } from '../types';

interface ChokeDetail {
  group: number;
  sourceIndex: number;
}

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
  onExclude?: (id: string) => void;
  onReroll?: (index: number) => void;
}

export const Pad: React.FC<PadProps> = ({
  index, sample, expectedCategory, chokeGroup, isLocked, onToggleLock, onExclude, onReroll
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const shouldPlayOnNextSample = useRef(false);

  useEffect(() => {
    if (!sample) {
      audioRef.current = null;
      return;
    }

    const audio = new Audio(sample.url);
    audioRef.current = audio;

    const handleEnded = () => setIsPlaying(false);
    const handlePause = () => setIsPlaying(false);
    const handleError = (e: Event) => {
      console.error('Audio error:', e);
      setIsPlaying(false);
    };

    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);

    // Only play automatically if this specific pad's Shuffle button was pressed
    if (shouldPlayOnNextSample.current) {
      shouldPlayOnNextSample.current = false;
      if (chokeGroup) {
        window.dispatchEvent(
          new CustomEvent<ChokeDetail>('choke', { detail: { group: chokeGroup, sourceIndex: index } })
        );
      }
      audio.play().catch(err => console.error('Audio playback error:', err));
      setIsPlaying(true);
    }

    return () => {
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
      audio.pause();
      audioRef.current = null;
    };
  }, [sample, chokeGroup, index]);

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

  const handlePlay = React.useCallback(() => {
    if (!audioRef.current) return;

    if (chokeGroup) {
      window.dispatchEvent(
        new CustomEvent<ChokeDetail>('choke', { detail: { group: chokeGroup, sourceIndex: index } })
      );
    }
    audioRef.current.currentTime = 0;
    audioRef.current.play().catch(error => {
      console.error('Audio playback error:', error);
      setIsPlaying(false);
    });
    setIsPlaying(true);
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
      className={`group relative overflow-hidden w-full aspect-square bg-[#1A1A1A] border rounded-lg p-3 sm:p-4 flex flex-col justify-between transition-all duration-100 ease-out text-left ${
        sample
          ? isPlaying
            ? 'border-accent-yellow shadow-[0_0_20px_var(--accent-yellow-glow)] scale-[0.98]'
            : 'border-[#333] hover:border-accent-yellow cursor-pointer'
          : 'border-[#333] opacity-50 cursor-not-allowed'
      }`}
    >
      <div className='flex w-full justify-between items-start'>
        <div className='flex items-center gap-1.5 sm:gap-2 flex-wrap'>
          <span className='text-xs sm:text-sm font-bold text-accent-yellow'>
            {(index + 1).toString().padStart(2, '0')}
          </span>
          {hotkey && (
            <span className='text-[10px] sm:text-xs font-mono text-[#888] bg-[#111] px-1.5 py-0.5 rounded border border-[#333] shrink-0' title={`Keyboard key [${hotkey}]`}>
              {hotkey}
            </span>
          )}
          {chokeGroup && (
            <span className='text-[8px] sm:text-[9px] uppercase tracking-widest text-accent-yellow/80 border border-accent-yellow/40 px-1.5 py-0.5 rounded-sm shrink-0'>
              Choke {chokeGroup}
            </span>
          )}
        </div>
        <div className={`w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full shrink-0 transition-all ${isPlaying ? 'bg-accent-yellow shadow-[0_0_8px_var(--accent-yellow)] scale-110' : 'border border-[#444]'}`}></div>
      </div>

      <div className='w-full mt-auto mb-8 sm:mb-9'>
        <div className='w-full text-[10px] sm:text-xs uppercase tracking-wider text-[#666] font-medium mb-0.5'>
          {sample ? sample.category : expectedCategory}
        </div>
        <div className='w-full flex items-center justify-between gap-1'>
          <div className='text-xs sm:text-sm truncate font-medium text-[#E0E0E0] pr-1'>
            {sample ? sample.name : 'Empty'}
          </div>
          <div className='flex items-center gap-1 shrink-0'>
            {sample && onExclude && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  onExclude(sample.id);
                }}
                className='text-[#666] hover:text-red-400 transition-colors p-1'
                title='Exclude sample'
                aria-label={`Exclude ${sample.name}`}
              >
                <Ban size={13} className='sm:w-3.5 sm:h-3.5' />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Split Bottom Bar: 50% Lock + 50% Shuffle */}
      <div className='absolute bottom-0 left-0 right-0 h-7 sm:h-8 flex items-stretch border-t border-[#2A2A2A] bg-[#111] z-10'>
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
              ? 'text-[#333] cursor-not-allowed'
              : isLocked
                ? 'bg-accent-yellow/20 text-accent-yellow font-semibold cursor-pointer'
                : 'text-[#555] hover:text-[#CCC] hover:bg-[#1C1C1C] cursor-pointer'
          }`}
        >
          {isLocked ? <Lock size={13} /> : <Unlock size={13} />}
          <span className='text-[10px] uppercase tracking-wider font-semibold'>
            {isLocked ? 'Locked' : 'Lock'}
          </span>
        </button>

        <button
          type='button'
          disabled={!sample || isLocked || !onReroll}
          onClick={(e) => {
            e.stopPropagation();
            if (onReroll) {
              shouldPlayOnNextSample.current = true;
              onReroll(index);
            }
          }}
          className={`w-1/2 border-l border-[#2A2A2A] flex items-center justify-center gap-1.5 transition-colors ${
            !sample || isLocked || !onReroll
              ? 'text-[#333] cursor-not-allowed'
              : 'text-[#777] hover:text-accent-yellow hover:bg-[#1C1C1C] cursor-pointer'
          }`}
          title='Shuffle sample on this pad'
          aria-label={`Shuffle sample on pad ${index + 1}`}
        >
          <RefreshCw size={12} />
          <span className='text-[10px] uppercase tracking-wider font-semibold'>
            Shuffle
          </span>
        </button>
      </div>
    </div>
  );
};
