/**
 * Wraps `fn` so it runs at most once per `intervalMs`. Calls inside the window are dropped,
 * not queued: the next call after the window carries the newer value. That suits a running
 * count, where the caller clears the display when the scan ends and a trailing call would
 * only repaint a row that is about to be replaced. `now` is a parameter so tests need no clock.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
  now: () => number = Date.now
): (...args: A) => void {
  let last = -Infinity;
  return (...args: A) => {
    const t = now();
    if (t - last < intervalMs) return;
    last = t;
    fn(...args);
  };
}

/** How often the pending folder row may repaint during a scan. */
export const SCAN_UI_INTERVAL_MS = 80;

const plural = (n: number) => `${n.toLocaleString('en-US')} file${n === 1 ? '' : 's'}`;

/**
 * Text for a pending folder row. `visible` is the line under the name; `announce` is the
 * screen-reader text, with the count rounded down to a hundred so a polite live region is
 * not asked to read ten updates a second.
 */
export function describeScanProgress(folder: string, files: number): { visible: string; announce: string } {
  if (files <= 0) return { visible: 'Scanning…', announce: `Scanning ${folder}` };
  const spoken = Math.floor(files / 100) * 100;
  return {
    visible: `Scanning… ${plural(files)}`,
    announce: spoken === 0 ? `Scanning ${folder}` : `Scanning ${folder}: ${plural(spoken)}`
  };
}
