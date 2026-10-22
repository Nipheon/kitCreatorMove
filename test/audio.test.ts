/**
 * Node-run checks for the fading voices in utils/audioEngine.ts.
 * Run with: npm test
 *
 * The element, the context and the timers are fakes: what is pinned here is what the engine asks
 * of them (a 20 ms ramp to zero, the pause only after it, a retrigger on the idle voice), not
 * what a browser then does with it.
 */
import assert from 'node:assert/strict';
import { EngineDeps, FADE_OUT_S, fadeOutAll, triggerFrom, Voice } from '../src/utils/audioEngine';

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n     ${(err as Error).message}`);
  }
}

class FakeAudio {
  currentTime = 0;
  paused = true;
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn); }
  removeEventListener(type: string, fn: () => void) { this.listeners.get(type)?.delete(fn); }
  emit(type: string) { this.listeners.get(type)?.forEach(fn => fn()); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

function setup(state = 'running', wired = true) {
  const log: string[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const gains: { value: number; calls: string[]; disconnected: boolean }[] = [];
  let holds = 0;
  const context = {
    state,
    currentTime: 1,
    destination: {},
    createMediaElementSource: () => ({ connect: () => {}, disconnect: () => { log.push('source off'); } }),
    createGain: () => {
      const g = { value: 1, calls: [] as string[], disconnected: false };
      gains.push(g);
      return {
        gain: {
          get value() { return g.value; },
          set value(v: number) { g.value = v; },
          cancelScheduledValues: (t: number) => { g.calls.push(`cancel@${t}`); },
          setValueAtTime: (v: number, t: number) => { g.calls.push(`set ${v}@${t}`); g.value = v; },
          linearRampToValueAtTime: (v: number, t: number) => { g.calls.push(`ramp ${v}@${t.toFixed(3)}`); }
        },
        connect: () => {},
        disconnect: () => { g.disconnected = true; }
      };
    }
  };
  const deps: EngineDeps = {
    context: () => (wired ? context : null),
    hold: () => { holds++; return () => { holds--; }; },
    after: (ms, run) => { timers.push({ ms, run }); }
  };
  const voice = () => {
    const audio = new FakeAudio();
    return { audio, voice: new Voice(audio as unknown as HTMLAudioElement, deps) };
  };
  return { context, deps, gains, timers, log, holds: () => holds, voice };
}

await test('fadeOut ramps the gain to zero over 20 ms and pauses only after it', async () => {
  const t = setup();
  const { audio, voice } = t.voice();
  await voice.play();
  assert.equal(voice.playing, true);
  voice.fadeOut();
  assert.deepEqual(t.gains[0].calls.slice(-3), ['cancel@1', 'set 1@1', `ramp 0@${(1 + FADE_OUT_S).toFixed(3)}`]);
  assert.equal(audio.paused, false, 'still sounding while it fades');
  assert.equal(t.timers.length, 1);
  assert.ok(t.timers[0].ms >= FADE_OUT_S * 1000, 'the pause waits for the ramp');
  audio.currentTime = 0.4;
  t.timers[0].run();
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 0, 'rewound for the next trigger');
  assert.equal(voice.playing, false);
});

await test('a play during the fade cancels the pending pause and restores full volume', async () => {
  const t = setup();
  const { audio, voice } = t.voice();
  await voice.play();
  voice.fadeOut();
  await voice.play();
  t.timers[0].run();
  assert.equal(audio.paused, false);
  assert.equal(voice.playing, true);
  assert.equal(t.gains[0].calls.slice(-1)[0], 'set 1@1');
});

await test('without a running context the fade is the old hard cut', async () => {
  for (const [state, wired] of [['suspended', true], ['running', false]] as const) {
    const t = setup(state, wired);
    const { audio, voice } = t.voice();
    await voice.play();
    voice.fadeOut();
    assert.equal(audio.paused, true, `${state}/${wired ? 'context' : 'no context'}`);
    assert.equal(t.timers.length, 0);
    assert.equal(voice.playing, false);
  }
});

await test('a second fadeOut during a fade does not restart the ramp', async () => {
  const t = setup();
  const { voice } = t.voice();
  await voice.play();
  voice.fadeOut();
  voice.fadeOut();
  assert.equal(t.gains[0].calls.filter(c => c.startsWith('ramp')).length, 1);
  assert.equal(t.timers.length, 1);
});

await test('a voice that started before the context ran joins the graph at fadeOut and still fades', async () => {
  const t = setup('suspended');
  const { audio, voice } = t.voice();
  await voice.play();
  assert.equal(t.gains.length, 0, 'started directly');
  t.context.state = 'running';
  voice.fadeOut();
  assert.equal(t.gains.length, 1);
  assert.ok(t.gains[0].calls.some(c => c.startsWith('ramp 0')));
  assert.equal(audio.paused, false, 'not cut');
  t.timers[0].run();
  assert.equal(audio.paused, true);
});

await test('fadeOut on an idle voice does nothing', () => {
  const t = setup();
  const { audio, voice } = t.voice();
  voice.fadeOut();
  assert.equal(t.timers.length, 0);
  assert.equal(audio.paused, true);
});

await test('the context is held for as long as a voice sounds, and released at the end', async () => {
  const t = setup();
  const a = t.voice();
  await a.voice.play();
  assert.equal(t.holds(), 1);
  a.audio.emit('ended');
  assert.equal(a.voice.playing, false);
  assert.equal(t.holds(), 0);
  const b = t.voice();
  await b.voice.play();
  b.voice.fadeOut();
  assert.equal(t.holds(), 1, 'held through the fade');
  t.timers[0].run();
  assert.equal(t.holds(), 0);
});

await test('a rejected play (an aborted AIFF load) leaves the voice stopped and the hold released', async () => {
  const t = setup();
  const { audio, voice } = t.voice();
  audio.play = () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await assert.rejects(voice.play(), /aborted/);
  assert.equal(voice.playing, false);
  assert.equal(t.holds(), 0);
});

await test('triggerFrom: an idle voice plays, the sounding one fades; a full pool restarts the oldest', async () => {
  const t = setup();
  const a = t.voice();
  const b = t.voice();
  const pool = [a.voice, b.voice];
  assert.equal(triggerFrom(pool), a.voice, 'both idle: the first');
  await a.voice.play();
  const second = triggerFrom(pool);
  assert.equal(second, b.voice, 'a is busy, b is idle');
  assert.equal(t.timers.length, 1, 'a was told to fade');
  await b.voice.play();
  assert.equal(triggerFrom(pool), a.voice, 'both busy: a started first');
  t.timers.forEach(timer => timer.run());
});

await test('fadeOutAll fades every sounding voice and skips idle ones', async () => {
  const t = setup();
  const a = t.voice();
  const b = t.voice();
  await a.voice.play();
  fadeOutAll([a.voice, b.voice]);
  assert.equal(t.timers.length, 1);
});

await test('dispose of a sounding voice fades it, then leaves the graph; of an idle one leaves at once', async () => {
  const t = setup();
  const a = t.voice();
  await a.voice.play();
  a.voice.dispose();
  assert.equal(t.gains[0].disconnected, false, 'still in the graph while it fades');
  t.timers[0].run();
  assert.equal(a.audio.paused, true);
  assert.equal(t.gains[0].disconnected, true);
  assert.equal(t.holds(), 0);

  const b = t.voice();
  await b.voice.play();
  b.audio.emit('ended');
  b.voice.dispose();
  assert.equal(t.gains[1].disconnected, true);
});

await test('a voice is not wired while the context is not running, and wires on a later play', async () => {
  const t = setup('suspended');
  const { voice } = t.voice();
  await voice.play();
  assert.equal(t.gains.length, 0);
  t.context.state = 'running';
  await voice.play();
  assert.equal(t.gains.length, 1);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall audio tests passed');
