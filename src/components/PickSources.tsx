import { FolderOpen, Files } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

/** The one place the sidebar hint is worded; README and the help text describe the same thing. */
export const PICK_HINT_FINE = 'Drag sample folders anywhere on this window.';
export const PICK_HINT_COARSE =
  'Pick the sample folders on your device. If your browser only lets you pick files, use Pick files.';

const COARSE_QUERY = '(pointer: coarse)';

/** Touch-first devices cannot drag a folder in, so the buttons take over there. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COARSE_QUERY);
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return coarse;
}

const AUDIO_ACCEPT = '.wav,.aif,.aiff,audio/wav,audio/x-wav,audio/aiff,audio/x-aiff';

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-yellow';
const BASE = `flex-1 flex items-center justify-center gap-1.5 rounded font-semibold uppercase whitespace-nowrap transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${FOCUS}`;
const SECONDARY = 'px-2 py-1.5 text-xs tracking-wide bg-surface-pad hover:bg-surface-btn-hover border border-border-main hover:border-accent-yellow text-text-light hover:text-accent-yellow';
const PROMINENT = 'px-3 py-3 min-h-11 text-sm tracking-wider bg-accent-yellow text-text-inverse hover:brightness-110';

/**
 * The hint line plus the two picker buttons. Both inputs hand their files to `onPick`
 * (the same pipeline as a drop). The selection is copied before the input is reset:
 * clearing `value` empties the live FileList, and without the reset picking the same
 * folder twice fires no change event.
 */
export function PickSources({ onPick, disabled }: { onPick: (files: File[]) => void; disabled: boolean }) {
  const coarse = useCoarsePointer();
  const folderInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length > 0 && !disabled) onPick(files);
  };

  const style = `${BASE} ${coarse ? PROMINENT : SECONDARY}`;

  return (
    <>
      <p className='text-sm text-text-subtle mb-3 shrink-0'>{coarse ? PICK_HINT_COARSE : PICK_HINT_FINE}</p>
      <div className='flex gap-2 mb-4 shrink-0'>
        <button
          type='button'
          className={style}
          disabled={disabled}
          onClick={() => folderInput.current?.click()}
          aria-label='Pick sample folders from your device'
        >
          <FolderOpen size={16} aria-hidden='true' />
          <span>Pick folders</span>
        </button>
        <button
          type='button'
          className={style}
          disabled={disabled}
          onClick={() => fileInput.current?.click()}
          aria-label='Pick sample files from your device'
        >
          <Files size={16} aria-hidden='true' />
          <span>Pick files</span>
        </button>
      </div>
      <input
        ref={folderInput}
        type='file'
        multiple
        hidden
        tabIndex={-1}
        aria-hidden='true'
        data-testid='pick-folders-input'
        onChange={handleChange}
        {...{ webkitdirectory: '' }}
      />
      <input
        ref={fileInput}
        type='file'
        multiple
        hidden
        tabIndex={-1}
        aria-hidden='true'
        accept={AUDIO_ACCEPT}
        data-testid='pick-files-input'
        onChange={handleChange}
      />
    </>
  );
}
