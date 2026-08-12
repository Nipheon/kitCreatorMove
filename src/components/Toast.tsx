import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ToastProps {
  isVisible: boolean;
  unavailableRoles: string[];
  substitutedCount: number;
  emptyCount: number;
  onClose: () => void;
}

/**
 * Presentational only — App owns both when the toast appears and when it times out.
 *
 * It used to run its own 5s dismiss timer alongside App's, which was two sources of
 * truth for one behaviour, and the one here never worked: `onClose` is a new closure on
 * every App render and sat in the effect's dependencies, so the timer restarted on every
 * re-render. A preview alone re-renders App often enough to keep resetting it forever.
 */
export const Toast: React.FC<ToastProps> = ({
  isVisible,
  unavailableRoles,
  substitutedCount,
  emptyCount,
  onClose,
}) => {
  if (!isVisible) return null;
  if (unavailableRoles.length === 0 && substitutedCount === 0 && emptyCount === 0) return null;

  return (
    // role="status" with aria-live="polite": role="alert" implies assertive, which
    // fought the explicit polite and left the announcement up to the screen reader.
    // A kit that filled imperfectly is not worth interrupting anyone mid-sentence.
    <div
      role="status"
      aria-live="polite"
      className="toast-enter fixed top-3 left-1/2 -translate-x-1/2 z-50 max-w-xl bg-surface-modal/95 backdrop-blur-md border border-warning-border rounded-xl shadow-2xl px-4 py-2.5 flex items-center gap-3 text-sm text-text-bright"
    >
      <AlertTriangle className="w-4 h-4 text-warning-amber shrink-0" />
      <div className="flex flex-col sm:flex-row sm:items-center gap-x-3 gap-y-0.5 text-xs sm:text-sm">
        {unavailableRoles.length > 0 && (
          <div>No {unavailableRoles.join(', ')} samples in library</div>
        )}
        {substitutedCount > 0 && (
          <div>{substitutedCount} pad(s) filled from other category</div>
        )}
        {emptyCount > 0 && (
          <div>{emptyCount} pad(s) left empty</div>
        )}
      </div>
      <button
        onClick={onClose}
        className="text-text-muted hover:text-text-bright p-1 rounded-lg hover:bg-surface-btn-hover transition-colors cursor-pointer shrink-0 ml-1"
        aria-label="Close warning toast"
      >
        <X size={15} />
      </button>
    </div>
  );
};

