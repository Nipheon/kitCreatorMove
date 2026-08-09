import { FolderUp, RefreshCw, Download, Music, X } from 'lucide-react';
import React, { useState, useCallback, useRef, useMemo } from 'react';
import { Pad } from './components/Pad';
import { Category, Sample, SourceFolder } from './types';
import { exportKitZip } from './utils/exporter';
import { categorizeSample, getFilesFromDataTransfer } from './utils/fileReader';
import { generateRandomKit } from './utils/kitGenerator';

const EXPECTED_CATEGORIES = [
  'Kick', 'Snare', 'CHH', 'OHH',
  'Kick', 'Snare', 'CHH', 'OHH',
  'Kick', 'Snare', 'CHH', 'OHH',
  'Clap', 'Clap', 'Perc', 'Perc'
];

export default function App() {
  const [isDragging, setIsDragging] = useState(false);
  const [sourceFolders, setSourceFolders] = useState<SourceFolder[]>([]);
  const [kit, setKit] = useState<(Sample | null)[]>(new Array(16).fill(null));
  const [isLoading, setIsLoading] = useState(false);

  const samples = useMemo(() => sourceFolders.flatMap(f => f.samples), [sourceFolders]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const processFiles = async (items: DataTransferItemList) => {
    setIsLoading(true);
    try {
      const folderData = await getFilesFromDataTransfer(items);
      
      const newFolders: SourceFolder[] = [];

      for (const folder of folderData) {
        const wavFiles = folder.files.filter(f => f.name.toLowerCase().endsWith('.wav'));
        if (wavFiles.length > 0) {
          const folderSamples: Sample[] = wavFiles.map(file => ({
            file,
            name: file.name,
            category: categorizeSample(file.name),
            url: URL.createObjectURL(file)
          }));
          newFolders.push({
            id: Math.random().toString(36).substring(7),
            name: folder.name || 'Dropped Files',
            samples: folderSamples
          });
        }
      }
      
      if (newFolders.length > 0) {
        setSourceFolders(prev => {
          const updated = [...prev, ...newFolders];
          const allSamples = updated.flatMap(f => f.samples);
          if (allSamples.length > 0) {
            setKit(generateRandomKit(allSamples));
          }
          return updated;
        });
      }
    } catch (error) {
      console.error('Failed to process files:', error);
      alert('Error processing files. Please try again.');
    } finally {
      setIsLoading(false);
      setIsDragging(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.items) {
      processFiles(e.dataTransfer.items);
    }
  }, []);

  const removeFolder = (id: string) => {
    setSourceFolders(prev => {
      const updated = prev.filter(f => f.id !== id);
      const remainingSamples = updated.flatMap(f => f.samples);
      if (remainingSamples.length > 0) {
        setKit(generateRandomKit(remainingSamples));
      } else {
        setKit(new Array(16).fill(null));
      }
      return updated;
    });
  };

  const randomizeKit = () => {
    if (samples.length > 0) {
      setKit(generateRandomKit(samples));
    }
  };

  const [kitName, setKitName] = useState('Move_Generated_Kit');

  const exportKit = () => {
    if (kit.some(s => s !== null)) {
      exportKitZip(kit, kitName);
    }
  };

  // Move uses 4x4 grid starting from bottom-left like standard Push/Drum Rack layout
  // We'll visually render it inverted so Pad 1 is bottom left
  const displayIndices = [
    12, 13, 14, 15,
    8, 9, 10, 11,
    4, 5, 6, 7,
    0, 1, 2, 3
  ];

  return (
    <div 
      className="flex flex-col h-screen w-screen bg-[#090909] text-[#E0E0E0] font-sans overflow-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag Overlay */}
      {isDragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#090909]/90 backdrop-blur-sm border-2 border-dashed border-[#00FFFC] m-4 rounded-xl">
          <div className="text-center animate-pulse">
            <FolderUp className="w-16 h-16 text-[#00FFFC] mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-[#E0E0E0] uppercase tracking-widest">Drop Sample Folders Here</h2>
            <p className="text-[#888] mt-2 text-sm uppercase tracking-wider">Scanning audio files...</p>
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
        <div className='flex items-center gap-6 text-xs font-medium uppercase tracking-wider'>
          <div className='flex items-center gap-2'>
            <span className='w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'></span>
            <span>Device Connected: Move (SN-4029)</span>
          </div>
          <div className='text-[#666]'>Firmware: v1.1.2</div>
        </div>
      </header>

      <main className='flex flex-1 overflow-hidden'>
        <aside className='w-72 bg-[#0E0E0E] border-r border-[#222] p-6 flex flex-col overflow-y-auto'>
          <div className='mb-8'>
            <h2 className='text-[10px] uppercase tracking-[0.2em] text-[#666] mb-4'>Source Folders</h2>
            <div className='border-2 border-dashed border-[#333] rounded-lg p-4 text-center hover:border-[#00FFFC] transition-colors cursor-pointer mb-4 pointer-events-none'>
              <div className='text-2xl mb-2 text-[#444]'>+</div>
              <p className='text-[11px] text-[#888]'>Drag sample folders here</p>
            </div>
            {sourceFolders.map(folder => (
              <div key={folder.id} className='space-y-2 mt-2'>
                <div className='bg-[#1A1A1A] px-3 py-2 rounded flex items-center justify-between group'>
                  <span className='text-xs truncate text-[#E0E0E0]'>{folder.name} <span className="text-[#888]">({folder.samples.length})</span></span>
                  <button onClick={() => removeFolder(folder.id)} className='text-[10px] text-[#555] group-hover:text-red-400'>✕</button>
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
                <span>Total Samples</span>
                <span>{samples.length.toLocaleString()}</span>
              </div>
              <div className='w-full bg-[#333] h-1 rounded-full overflow-hidden'>
                <div className={`bg-[#00FFFC] h-full transition-all`} style={{ width: samples.length > 0 ? '100%' : '0%' }}></div>
              </div>
            </div>
          </div>
        </aside>

        <section className='flex-1 bg-[#090909] flex flex-col items-center justify-center p-8 overflow-y-auto'>
          <div className='grid grid-cols-4 gap-3 mb-8'>
            {displayIndices.map((index) => {
              const chokeGroup = (index === 2 || index === 3) ? 1 :
                                 (index === 6 || index === 7) ? 2 :
                                 (index === 10 || index === 11) ? 3 : undefined;
              return (
                <Pad 
                  key={index}
                  index={index}
                  sample={kit[index]}
                  expectedCategory={EXPECTED_CATEGORIES[index]}
                  chokeGroup={chokeGroup}
                />
              );
            })}
          </div>
          <div className='flex gap-4'>
            <button 
              onClick={randomizeKit}
              className='px-8 py-3 bg-[#00FFFC] text-black font-bold uppercase text-xs tracking-widest rounded-full hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
              disabled={samples.length === 0}
            >
              Generate Random Kit
            </button>
          </div>
        </section>

        <aside className='w-80 bg-[#0E0E0E] border-l border-[#222] p-6 flex flex-col overflow-y-auto'>
          <h2 className='text-[10px] uppercase tracking-[0.2em] text-[#666] mb-6'>Preset Settings</h2>
          <div className='space-y-6'>
            <div className='space-y-2'>
              <label className='text-[10px] text-[#888] uppercase'>Preset Name</label>
              <input 
                type='text' 
                value={kitName}
                onChange={(e) => setKitName(e.target.value)}
                className='w-full bg-[#1A1A1A] border border-[#333] rounded px-3 py-2 text-sm focus:border-[#00FFFC] outline-none text-[#E0E0E0]'
              />
            </div>
            <div className='space-y-2'>
              <label className='text-[10px] text-[#888] uppercase'>Kit Template</label>
              <select className='w-full bg-[#1A1A1A] border border-[#333] rounded px-3 py-2 text-sm appearance-none outline-none text-[#E0E0E0]'>
                <option>Ableton Drum Rack (Move Compatible)</option>
                <option>8-Pad Classic</option>
              </select>
            </div>
            <div className='pt-6 border-t border-[#222]'>
              <div className='flex justify-between text-xs mb-1'><span>Bit Depth</span><span className='text-[#00FFFC]'>16-bit</span></div>
              <div className='flex justify-between text-xs mb-1'><span>Sample Rate</span><span className='text-[#00FFFC]'>44.1 kHz</span></div>
              <div className='flex justify-between text-xs'><span>Compression</span><span className='text-[#00FFFC]'>None (WAV)</span></div>
            </div>
          </div>
          <div className='mt-auto pt-6'>
            <button 
              onClick={exportKit}
              disabled={kit.every(s => s === null)}
              className='w-full py-4 bg-white text-black font-bold uppercase text-xs tracking-[0.2em] rounded flex items-center justify-center gap-2 hover:bg-[#E0E0E0] transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
            >
              <svg className='w-4 h-4' fill='currentColor' viewBox='0 0 20 20'>
                <path d='M11 3a1 1 0 10-2 0v1h2V3zM7 5a1 1 0 011 1v1h2V6a1 1 0 112 0v1h1a1 1 0 110 2h-1v2h1a1 1 0 110 2h-1v1a1 1 0 11-2 0v-1H9v1a1 1 0 11-2 0v-1H6a1 1 0 110-2h1v-2H6a1 1 0 110-2h1V6a1 1 0 011-1z'/>
              </svg>
              Export To Move
            </button>
          </div>
        </aside>
      </main>
      
      <footer className='bg-[#111] border-t border-[#222] px-8 py-2 flex justify-between items-center text-[9px] text-[#555] uppercase tracking-widest shrink-0'>
        <div>Version 1.0.4-Beta</div>
        <div>© 2024 Move Toolkit</div>
      </footer>
    </div>
  );
}
