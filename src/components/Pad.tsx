import { Play, Square } from 'lucide-react';
import React, { useRef, useState, useEffect } from 'react';
import { Sample } from '../types';

interface PadProps {
  index: number;
  sample: Sample | null;
  expectedCategory: string;
}

export const Pad: React.FC<PadProps> = ({ index, sample, expectedCategory }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (sample) {
      audioRef.current = new Audio(sample.url);
      audioRef.current.addEventListener('ended', () => setIsPlaying(false));
      audioRef.current.addEventListener('pause', () => setIsPlaying(false));
    }
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [sample]);

  const handlePlay = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
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
        <span className='text-[10px] font-bold text-[#00FFFC]'>
          {(index + 1).toString().padStart(2, '0')}
        </span>
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
