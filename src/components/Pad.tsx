import { Ban, Lock, Unlock } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { Sample } from '../types';

interface ChokeDetail {
  group: number;
  sourceIndex: number;
}

interface PadProps {
  index: number;
  sample: Sample | null;
  expectedCategory: string;
  chokeGroup: number | null;
  isLocked: boolean;
  onToggleLock: () => void;
  onExclude?: (id: string) => void;
}

export const Pad: React.FC<PadProps> = ({
  index, sample, expectedCategory, chokeGroup, isLocked, onToggleLock, onExclude
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

    return () => {
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
      audio.pause();
      audioRef.current = null;
    };
  }, [sample]);

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

  // A div rather than a button: the lock and exclude controls are buttons themselves,
  // and interactive elements cannot be nested inside a button.
  return (
    <div
      role="button"
      tabIndex={sample ? 0 : -1}
      aria-disabled={!sample}
      aria-label={sample ? `Play ${sample.name}` : `Pad ${index + 1}, empty`}
      onClick={sample ? handlePlay : undefined}
      onKeyDown={sample ? handleKeyDown : undefined}
      className={`relative overflow-hidden w-full aspect-square bg-[#1A1A1A] border rounded-md p-2 flex flex-col transition-all duration-100 ease-out text-left ${
        sample
          ? isPlaying
            ? 'border-[#00FFFC] shadow-[0_0_15px_rgba(0,255,252,0.3)] scale-[0.98]'
            : 'border-[#333] hover:border-[#00FFFC] cursor-pointer'
          : 'border-[#333] opacity-50 cursor-not-allowed'
      }`}
    >
      <div className='flex w-full justify-between items-start'>
        <div className='flex items-center gap-2'>
          <span className='text-[10px] font-bold text-[#00FFFC]'>
            {(index + 1).toString().padStart(2, '0')}
          </span>
          {chokeGroup && (
            <span className='text-[7px] uppercase tracking-widest text-[#00FFFC]/70 border border-[#00FFFC]/30 px-1 rounded-sm'>
              Choke {chokeGroup}
            </span>
          )}
        </div>
        <div className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-[#00FFFC]' : 'border border-[#444]'}`}></div>
      </div>

      <div className='w-full mt-auto mb-6'>
        <div className='w-full text-[9px] uppercase tracking-tighter text-[#666]'>
          {sample ? sample.category : expectedCategory}
        </div>
        <div className='w-full flex items-center justify-between'>
          <div className='text-[10px] truncate font-medium text-[#E0E0E0] pr-1'>
            {sample ? sample.name : 'Empty'}
          </div>
          {sample && onExclude && (
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                onExclude(sample.id);
              }}
              className='text-[#555] hover:text-red-400 transition-colors shrink-0'
              title='Exclude sample'
              aria-label={`Exclude ${sample.name}`}
            >
              <Ban size={10} />
            </button>
          )}
        </div>
      </div>

      {/* Empty pads are deliberately not lockable — there is nothing to hold. */}
      <button
        type='button'
        disabled={!sample}
        onClick={(e) => {
          e.stopPropagation();
          onToggleLock();
        }}
        aria-pressed={isLocked}
        aria-label={isLocked ? `Unlock pad ${index + 1}` : `Lock pad ${index + 1}`}
        className={`absolute bottom-0 left-0 right-0 h-6 flex items-center justify-center transition-colors ${
          !sample
            ? 'bg-[#111] text-[#333] cursor-not-allowed'
            : isLocked
              ? 'bg-[#00FFFC]/20 text-[#00FFFC] cursor-pointer'
              : 'bg-[#111] text-[#444] hover:text-[#888] cursor-pointer'
        }`}
      >
        {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
    </div>
  );
};
