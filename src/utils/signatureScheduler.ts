import { Sample } from '../types';
import { fileSignature } from './sampleSignature';

/** Samples hashed concurrently between two yields. */
export const SIGNATURE_BATCH = 4;

/** Lets the browser paint, play preview audio and run animations between hashing steps. */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise(resolve => {
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 0);
  });

export interface SignatureJobOptions {
  /** False once the sample's folder was removed: its signature is skipped. */
  isAlive?: (sample: Sample) => boolean;
  /** Injected so tests can observe and drive the yields. */
  yieldFn?: () => Promise<void>;
  compute?: (file: Blob) => Promise<string>;
  batch?: number;
}

/**
 * Fills `Sample.signature` in the background after a drop, a few files at a time, yielding to the
 * event loop between steps so loading never competes with the UI. This deliberately mutates the
 * samples in place: nothing renders from `signature`, and kit generation reads it at call time
 * through `sampleIdentity`, which falls back to name plus size until it is set. Samples that
 * already have a signature are left alone.
 */
export async function computeSignaturesInBackground(samples: Sample[], opts: SignatureJobOptions = {}): Promise<void> {
  const { isAlive = () => true, yieldFn = yieldToEventLoop, compute = fileSignature, batch = SIGNATURE_BATCH } = opts;
  for (let i = 0; i < samples.length; i += batch) {
    await yieldFn();
    const todo = samples.slice(i, i + batch).filter(s => s.signature === undefined && isAlive(s));
    const results = await Promise.all(todo.map(s => compute(s.file)));
    todo.forEach((s, k) => {
      if (isAlive(s)) s.signature = results[k];
    });
  }
}
