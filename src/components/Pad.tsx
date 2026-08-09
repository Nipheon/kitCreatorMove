import { Play, Square } from 'lucide-react';
import React, { useRef, useState, useEffect } from 'react';
import { Sample } from '../types';

interface PadProps {
  index: number;
  sample: Sample | null;
  expectedCategory: string;
  chokeGroup?: number;
}

export const Pad: React.FC<PadProps> = ({ index, sample, expectedCategory, chokeGroup }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (sample) {
      const audio = new Audio(sample.url);
      audioRef.current = audio;
      
      const handleEnded = () => setIsPlaying(false);
      const handlePause = () => setIsPlaying(false);
      const handleError = (e: Event) => {
        console.error("Audio error:", e);
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
    }
    return () => {
      audioRef.current = null;
    };
  }, [sample]);

  useEffect(() => {
    const onChoke = (e: any) => {
      if (chokeGroup && e.detail.group === chokeGroup && e.detail.sourceIndex !== index) {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
          setIsPlaying(false);
        }
      }
    };
    window.addEventListener('choke', onChoke);
    return () => window.removeEventListener('choke', onChoke);
  }, [chokeGroup, index]);

  const handlePlay = () => {
    if (audioRef.current) {
      if (chokeGroup) {
        window.dispatchEvent(new CustomEvent('choke', { detail: { group: chokeGroup, sourceIndex: index } }));
      }
      audioRef.current.currentTime = 0;
      const playPromise = audioRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.error("Audio playback error:", error);
          setIsPlaying(false);
        });
      }
      setIsPlaying(true);
    }
  };

  return (
    <button
      onClick={handlePlay}
      disabled={!sample}
      className={`w-32 h-32 bg-[#1A1A1A] border rounded-md p-2 flex flex-col justify-between transition-all duration-100 ease-out text-left ${
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
      <div className='w-full text-[9px] uppercase tracking-tighter text-[#666]'>
        {sample ? sample.category : expectedCategory}
      </div>
      <div className='w-full text-[10px] truncate font-medium text-[#E0E0E0]'>
        {sample ? sample.name : 'Empty'}
      </div>
    </button>
  );
};

