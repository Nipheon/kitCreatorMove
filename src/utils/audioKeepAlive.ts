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

function sync() {
  if (!context) return;
  const action = pageIsActive() ? context.resume() : context.suspend();
  action.catch(() => {});
}

/** Call from a user gesture: the autoplay policy keeps the context suspended until then. */
export function startAudioKeepAlive() {
  if (typeof AudioContext === 'undefined') return;

  if (!context) {
    try {
      context = new AudioContext();
      const source = context.createConstantSource();
      source.offset.value = 0;
      source.connect(context.destination);
      source.start();
    } catch {
      context = null;
      return;
    }
  }

  if (!installed) {
    installed = true;
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
  }
  sync();
}
