/**
 * One voice per `<audio>` element, routed through the shared AudioContext so it can be faded:
 * element -> gain -> destination. Everything that used to cut a sound (a new trigger, a choke,
 * stop-all, a sample being replaced, closing the browser) calls `fadeOut`, a 20 ms linear ramp
 * to silence followed by the pause, so no waveform is chopped mid-cycle. That chop was the click.
 *
 * The element is only wired into the graph while the context is running. Before the first
 * gesture (or if Web Audio is missing) it plays directly and `fadeOut` degrades to the old
 * hard cut, so a blocked context can never make a pad silent.
 */
import { getAudioContext, holdPlayback } from './audioKeepAlive';

export const FADE_OUT_S = 0.02;
const FINISH_SLACK_MS = 10;

export interface AudioParamLike {
  value: number;
  cancelScheduledValues(time: number): unknown;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}
export interface GainLike {
  gain: AudioParamLike;
  connect(destination: unknown): unknown;
  disconnect(): void;
}
export interface SourceLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}
export interface ContextLike {
  state: string;
  currentTime: number;
  destination: unknown;
  createGain(): GainLike;
  createMediaElementSource(element: HTMLMediaElement): SourceLike;
}
/** Injected so tests can drive the engine without a browser. */
export interface EngineDeps {
  context(): ContextLike | null;
  hold(): () => void;
  after(ms: number, run: () => void): void;
}

const realDeps: EngineDeps = {
  context: () => getAudioContext() as unknown as ContextLike | null,
  hold: holdPlayback,
  after: (ms, run) => { setTimeout(run, ms); }
};

let started = 0;

export class Voice {
  playing = false;
  /** A fade is running: a second `fadeOut` must not restart the ramp and stretch it. */
  private fading = false;
  /** Order of the latest `play`, so a full pool can restart its oldest voice. */
  startedAt = 0;
  private source: SourceLike | null = null;
  private gain: GainLike | null = null;
  /** Bumped by every play, fade and stop; a pending finish that finds it changed does nothing. */
  private token = 0;
  private release: (() => void) | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();

  constructor(readonly audio: HTMLAudioElement, private deps: EngineDeps = realDeps) {
    audio.addEventListener('ended', this.handleEnded);
    audio.addEventListener('pause', this.handleEnded);
  }

  /** Called whenever `playing` changes; returns the unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Starts from the beginning at full volume. Rejects as `HTMLMediaElement.play()` does. */
  play(): Promise<void> {
    this.token++;
    this.fading = false;
    this.wire();
    const context = this.deps.context();
    if (this.gain && context) {
      const now = context.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(1, now);
    }
    this.audio.currentTime = 0;
    this.startedAt = ++started;
    this.setPlaying(true);
    const token = this.token;
    return this.audio.play().catch(err => {
      if (token === this.token) this.setPlaying(false);
      throw err;
    });
  }

  /** Fades to silence over `FADE_OUT_S`, then pauses and rewinds. Instant where the element is not in the graph. */
  fadeOut(): void {
    if (!this.playing || this.fading) return;
    const token = ++this.token;
    this.fading = true;
    const context = this.deps.context();
    if (this.gain && context && context.state === 'running') {
      const now = context.currentTime;
      const param = this.gain.gain;
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(0, now + FADE_OUT_S);
      this.deps.after(FADE_OUT_S * 1000 + FINISH_SLACK_MS, () => this.finish(token));
    } else {
      this.finish(token);
    }
  }

  /** Hard cut, for tearing down. */
  stop(): void {
    this.finish(++this.token);
  }

  /** The voice is no longer wanted: fade out if sounding, then leave the graph. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.audio.removeEventListener('ended', this.handleEnded);
    this.audio.removeEventListener('pause', this.handleEnded);
    if (this.playing) this.fadeOut();
    else this.unwire();
  }

  private finish(token: number): void {
    if (token !== this.token) return;
    this.fading = false;
    this.audio.pause();
    try { this.audio.currentTime = 0; } catch { /* not seekable yet */ }
    this.setPlaying(false);
    if (this.disposed) this.unwire();
  }

  private handleEnded = (): void => {
    if (!this.playing) return;
    this.token++;
    this.fading = false;
    this.setPlaying(false);
  };

  private wire(): void {
    if (this.gain) return;
    const context = this.deps.context();
    if (!context || context.state !== 'running') return;
    try {
      const source = context.createMediaElementSource(this.audio);
      const gain = context.createGain();
      source.connect(gain);
      gain.connect(context.destination);
      this.source = source;
      this.gain = gain;
    } catch {
      // The element already belongs to another graph: it plays directly, with a hard cut.
    }
  }

  private unwire(): void {
    this.gain?.disconnect();
    this.source?.disconnect();
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (playing) {
      this.release = this.deps.hold();
    } else {
      this.release?.();
      this.release = null;
    }
    this.listeners.forEach(listener => listener());
  }
}

/**
 * The voice a new trigger plays on: an idle one, else the one that started longest ago. Every
 * other sounding voice is faded out as the new one starts, so a retrigger overlaps for 20 ms
 * instead of restarting the same element (which clicked).
 */
export function triggerFrom(voices: readonly Voice[]): Voice {
  const next = voices.find(v => !v.playing) ?? voices.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
  voices.forEach(v => { if (v !== next) v.fadeOut(); });
  return next;
}

export const fadeOutAll = (voices: readonly Voice[]): void => voices.forEach(v => v.fadeOut());
