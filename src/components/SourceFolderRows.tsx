import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { SourceFolder } from '../types';
import { enableOnToggle, groupFolders, triState } from '../utils/folderGroups';


interface Props {
  folders: SourceFolder[];
  disabled: boolean;
  onToggle: (ids: string[], enable: boolean) => void;
  onRemove: (ids: string[]) => void;
}

const COUNT_BADGE = 'text-sm text-text-muted shrink-0 font-medium bg-surface-header px-2 py-0.5 rounded';
const ICON_BUTTON = 'text-text-muted-dark hover:text-text-bright transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed';
const REMOVE_BUTTON = 'text-sm font-bold text-text-muted-dark group-hover:text-danger-text ml-2 disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * The rows of Source Folders. A plain folder renders as it always has; a dropped collection
 * renders as a parent row (expand, tri-state eye, remove-all) above indented sub-pack rows.
 */
export function SourceFolderRows({ folders, disabled, onToggle, onRemove }: Props) {
  // Not persisted: only the user's own overrides are kept; everything else follows the default.
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});

  const folderRow = (folder: SourceFolder, nested: boolean) => (
    <div key={folder.id} className={`space-y-2 mt-2 ${nested ? 'ml-5' : ''} ${folder.isEnabled === false ? 'opacity-50' : ''}`}>
      <div className='bg-surface-pad px-3 py-2 rounded flex items-center justify-between group'>
        <div className='flex items-center gap-2 overflow-hidden flex-1'>
          <button
            onClick={() => onToggle([folder.id], folder.isEnabled === false)}
            disabled={disabled}
            className={ICON_BUTTON}
            title={folder.isEnabled === false ? 'Enable folder' : 'Disable folder'}
            aria-label={folder.isEnabled === false ? `Enable ${folder.name}` : `Disable ${folder.name}`}
          >
            {folder.isEnabled === false ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <span className='text-sm truncate text-text-bright flex-1'>{folder.name}</span>
          <span className={COUNT_BADGE}>{folder.samples.length}</span>
        </div>
        <button
          onClick={() => onRemove([folder.id])}
          disabled={disabled}
          className={REMOVE_BUTTON}
          aria-label={`Remove ${folder.name}`}
        >
          ✕
        </button>
      </div>
    </div>
  );

  return (
    <>
      {groupFolders(folders).map(row => {
        if (row.kind === 'folder') return folderRow(row.folder, false);

        const state = triState(row.children);
        const ids = row.children.map(c => c.id);
        const expanded = expandedOverride[row.id] ?? false;
        const total = row.children.reduce((n, c) => n + c.samples.length, 0);
        const enabledCount = row.children.filter(c => c.isEnabled !== false).length;
        const listId = `subpacks-${row.id}`;
        const stateText = state === 'on' ? 'all sub-packs on' : state === 'off' ? 'all sub-packs off' : `${enabledCount} of ${row.children.length} sub-packs on`;
        return (
          <div key={row.id} className='mt-2'>
            <div className={`space-y-2 ${state === 'off' ? 'opacity-50' : ''}`}>
              <div className='bg-surface-pad px-3 py-2 rounded flex items-center justify-between group'>
                <div className='flex items-center gap-2 overflow-hidden flex-1'>
                  <button
                    onClick={() => setExpandedOverride(prev => ({ ...prev, [row.id]: !expanded }))}
                    className={ICON_BUTTON}
                    aria-expanded={expanded}
                    aria-controls={listId}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.name}`}
                    title={expanded ? 'Collapse' : 'Expand'}
                  >
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <button
                    role='checkbox'
                    aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
                    onClick={() => onToggle(ids, enableOnToggle(state))}
                    disabled={disabled}
                    className={`${ICON_BUTTON} relative`}
                    title={state === 'on' ? 'Disable all sub-packs' : 'Enable all sub-packs'}
                    aria-label={`${row.name}: ${stateText}`}
                  >
                    {state === 'off' ? <EyeOff size={15} /> : <Eye size={15} />}
                    {state === 'mixed' && (
                      <span aria-hidden='true' className='absolute -bottom-1 -right-1 w-2 h-2 rounded-full bg-text-muted border border-surface-pad' />
                    )}
                  </button>
                  <div className='min-w-0 flex-1'>
                    <div className='text-sm truncate text-text-bright'>{row.name}</div>
                    <div className='text-xs text-text-muted'>{enabledCount}/{row.children.length} sub-packs</div>
                  </div>
                  <span className={COUNT_BADGE}>{total}</span>
                </div>
                <button
                  onClick={() => onRemove(ids)}
                  disabled={disabled}
                  className={REMOVE_BUTTON}
                  aria-label={`Remove ${row.name} and all its sub-packs`}
                >
                  ✕
                </button>
              </div>
            </div>
            <div id={listId} role='group' aria-label={`${row.name} sub-packs`} hidden={!expanded}>
              {row.children.map(child => folderRow(child, true))}
            </div>
          </div>
        );
      })}
    </>
  );
}
