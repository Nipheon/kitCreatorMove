/**
 * Bluetooth headphones go idle when nothing has played for a few seconds, and waking
 * the link takes ~100-300 ms, which eats the start of a short sample. While the page is
 * visible and focused, a silent stream keeps the output open. The moment the page loses
 * focus or is hidden the stream is suspended, so the headphones are released.
 *
 * Pure silence (offset 0) rather than faint noise: noise would light up the tab's audio indicator.
 */
let context: AudioContext | null = null;
let installed = false;

function pageIsActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function sync(): Promise<void> {
  if (!context) return Promise.resolve();
  const action = pageIsActive() ? context.resume() : context.suspend();
  return action.catch(() => {});
}

/**
 * Call from any user interaction. The autoplay policy keeps the context suspended until a
 * real gesture (a click or a key; a drop, Shift or Escape do not count), so this resolves
 * true only once the stream runs and the caller keeps retrying until then.
 */
export async function startAudioKeepAlive(): Promise<boolean> {
  if (typeof AudioContext === 'undefined') return true;

  if (!context) {
    try {
      context = new AudioContext();
      const source = context.createConstantSource();
      source.offset.value = 0;
      source.connect(context.destination);
      source.start();
    } catch {
      context = null;
      return true;
    }
  }

  if (!installed) {
    installed = true;
    document.addEventListener('visibilitychange', () => void sync());
    window.addEventListener('focus', () => void sync());
    window.addEventListener('blur', () => void sync());
  }
  await sync();
  return context?.state === 'running';
}
