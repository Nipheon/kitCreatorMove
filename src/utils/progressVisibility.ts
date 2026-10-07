/**
 * How long a duplicate check may run before its progress indicator appears. Most checks
 * finish well inside this, and an indicator that flashes for a few frames reads as a glitch.
 */
export const PROGRESS_DELAY_MS = 250;

/** Whether the indicator is visible `elapsedMs` after the work started. */
export function shouldShowProgress(elapsedMs: number, delayMs: number = PROGRESS_DELAY_MS): boolean {
  return elapsedMs >= delayMs;
}
