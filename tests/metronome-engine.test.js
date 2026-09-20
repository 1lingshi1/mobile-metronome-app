import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  MAX_BPM,
  MetronomeEngine,
  MIN_BPM,
  SUPPORTED_TIME_SIGNATURES
} from '../www/metronome-engine.js';

function createPlugin(initialState = {}) {
  const listeners = new Map();
  let state = {
    running: false,
    bpm: 120,
    beatsPerBar: 4,
    denominator: 4,
    beatIndex: 1,
    nextBeatIndex: 2,
    accentPattern: '2,0,0,0',
    volume: 5,
    nextBeatDelayMs: 0,
    ...initialState
  };

  return {
    calls: [],
    state() {
      return { ...state };
    },
    async addListener(eventName, listener) {
      listeners.set(eventName, listener);
      return {
        async remove() {
          listeners.delete(eventName);
        }
      };
    },
    async getState() {
      this.calls.push({ method: 'getState' });
      return { ...state };
    },
    async start(payload) {
      this.calls.push({ method: 'start', payload });
      state = {
        ...state,
        running: true,
        bpm: payload.bpm,
        beatsPerBar: payload.beatsPerBar,
        denominator: payload.denominator,
        beatIndex: payload.currentBeatIndex,
        nextBeatIndex: payload.nextBeatIndex,
        accentPattern: payload.accentPattern
      };
      return { ...state };
    },
    async update(payload) {
      this.calls.push({ method: 'update', payload });
      state = {
        ...state,
        bpm: payload.bpm,
        beatsPerBar: payload.beatsPerBar,
        denominator: payload.denominator,
        beatIndex: payload.currentBeatIndex,
        nextBeatIndex: payload.nextBeatIndex,
        accentPattern: payload.accentPattern
      };
      return { ...state };
    },
    async pause() {
      this.calls.push({ method: 'pause' });
      state = { ...state, running: false };
      return { ...state };
    },
    async reset() {
      this.calls.push({ method: 'reset' });
      state = { ...state, running: false, beatIndex: 1, nextBeatIndex: 2 };
      return { ...state };
    },
    async stop() {
      this.calls.push({ method: 'stop' });
      state = { ...state, running: false };
      return { ...state };
    },
    emit(eventName, payload) {
      const listener = listeners.get(eventName);
      if (listener) {
        listener(payload);
      }
    }
  };
}

async function flushUpdates() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('defaults match the product specification without creating WebAudio', () => {
  const engine = new MetronomeEngine({ plugin: createPlugin() });
  assert.deepEqual(engine.getState(), {
    bpm: 120,
    beatsPerBar: 4,
    beatIndex: 1,
    nextBeatIndex: 2,
    timeSignature: { numerator: 4, denominator: 4 },
    timeSignatureLabel: '4/4',
    accentPattern: [2, 0, 0, 0],
    isRunning: false,
    status: 'stopped'
  });
});

test('the supported time signatures match the requested order', () => {
  assert.deepEqual(
    SUPPORTED_TIME_SIGNATURES.map((signature) => `${signature.numerator}/${signature.denominator}`),
    ['2/4', '3/4', '4/4', '6/8', '9/8', '12/8', '5/4', '7/4']
  );
});

test('initialization attaches native listeners and restores the service snapshot', async () => {
  const plugin = createPlugin({
    running: true,
    bpm: 96,
    beatsPerBar: 3,
    denominator: 4,
    beatIndex: 2,
    nextBeatIndex: 3,
    accentPattern: '2,0,0'
  });
  const engine = new MetronomeEngine({ plugin });

  await engine.initialize();

  assert.equal(engine.getState().isRunning, true);
  assert.equal(engine.getState().bpm, 96);
  assert.equal(engine.getState().timeSignatureLabel, '3/4');
  assert.equal(engine.getState().beatIndex, 2);
  assert.equal(plugin.calls[0].method, 'getState');
  assert.equal(plugin.calls.some((call) => call.method === 'update'), true);
});

test('start, pause, and reset are delegated to the native service', async () => {
  const plugin = createPlugin();
  const engine = new MetronomeEngine({ plugin });

  const started = await engine.start();
  assert.equal(started.isRunning, true);
  assert.equal(plugin.calls[0].method, 'start');
  assert.equal(plugin.calls[0].payload.bpm, 120);

  const paused = await engine.pause();
  assert.equal(paused.status, 'paused');
  assert.equal(plugin.calls[1].method, 'pause');

  const reset = await engine.reset();
  assert.equal(reset.status, 'stopped');
  assert.equal(reset.beatIndex, 1);
  assert.equal(plugin.calls[2].method, 'reset');
});

test('resuming continues from the next beat instead of repeating the paused beat', async () => {
  const plugin = createPlugin();
  const engine = new MetronomeEngine({ plugin });
  await engine.start();
  engine._beatIndex = 3;
  engine._nextBeatIndex = 4;
  await engine.pause();
  await engine.start();

  const startCalls = plugin.calls.filter((call) => call.method === 'start');
  assert.equal(startCalls.at(-1).payload.currentBeatIndex, 4);
});

test('late native beats are ignored after the user pauses', async () => {
  const plugin = createPlugin();
  const engine = new MetronomeEngine({ plugin });
  const beats = [];
  engine.onBeat((payload) => beats.push(payload));
  await engine.initialize();
  await engine.start();
  await engine.pause();

  plugin.emit('beat', {
    beatIndex: 2,
    beatsPerBar: 4,
    denominator: 4,
    accentLevel: 0
  });

  assert.equal(beats.length, 0);
  assert.equal(engine.getState().status, 'paused');
});

test('late stopped snapshots cannot overwrite a reset back to the first beat', async () => {
  const plugin = createPlugin();
  const engine = new MetronomeEngine({ plugin });
  await engine.initialize();
  await engine.start();
  engine._beatIndex = 3;
  engine._nextBeatIndex = 4;
  await engine.reset();

  plugin.emit('state', {
    running: false,
    bpm: 120,
    beatsPerBar: 4,
    denominator: 4,
    beatIndex: 3,
    nextBeatIndex: 4,
    accentPattern: '2,0,0,0'
  });

  assert.equal(engine.getState().beatIndex, 1);
  assert.equal(engine.getState().status, 'stopped');
});

test('syncState restores the live native snapshot without restarting the service', async () => {
  const plugin = createPlugin({
    running: true,
    bpm: 144,
    beatIndex: 3,
    nextBeatIndex: 4
  });
  const engine = new MetronomeEngine({ plugin });
  const state = await engine.syncState();

  assert.equal(state.isRunning, true);
  assert.equal(state.bpm, 144);
  assert.equal(state.beatIndex, 3);
  assert.equal(plugin.calls.some((call) => call.method === 'start'), false);
});

test('native beat events update the proxy and drive UI listeners', async () => {
  const plugin = createPlugin();
  const engine = new MetronomeEngine({ plugin });
  const beats = [];
  engine.onBeat((payload) => beats.push(payload));
  await engine.initialize();
  await engine.start();

  plugin.emit('beat', {
    beatIndex: 4,
    beatsPerBar: 4,
    denominator: 4,
    accentLevel: 0
  });

  assert.equal(engine.getState().beatIndex, 4);
  assert.equal(engine.getState().isRunning, true);
  assert.deepEqual(beats, [{
    beatIndex: 4,
    beatsPerBar: 4,
    timeSignature: { numerator: 4, denominator: 4 },
    isDownbeat: false,
    isAccent: false,
    accentLevel: 0
  }]);
});

test('native beat events forward the projected audible timestamp to the UI', async () => {
  const plugin = createPlugin();
  const engine = new MetronomeEngine({ plugin });
  const beats = [];
  engine.onBeat((payload) => beats.push(payload));
  await engine.initialize();
  await engine.start();

  plugin.emit('beat', {
    beatIndex: 2,
    beatsPerBar: 4,
    denominator: 4,
    accentLevel: 0,
    audibleAtEpochMs: 1726800000123
  });

  assert.equal(beats.length, 1);
  assert.equal(beats[0].audibleAtEpochMs, 1726800000123);
});

test('main UI schedules beat markers at the projected audible time', async () => {
  const uiSource = await readFile(
    new URL('../www/ui-controller.js', import.meta.url),
    'utf8'
  );
  assert.match(uiSource, /const renderBeat = \(payload\) =>/);
  assert.match(uiSource, /payload\.audibleAtEpochMs/);
  assert.match(uiSource, /scheduleAtAudibleTime\(payload\.audibleAtEpochMs/);
  assert.match(uiSource, /void nextMarker\.offsetWidth/);
  assert.match(uiSource, /const shouldSyncBeat = options\.syncBeat === true \|\| !state\.isRunning/);

  const serviceSource = await readFile(
    new URL('../android/app/src/main/java/com/mobilemetronome/app/BackgroundMetronomeService.java', import.meta.url),
    'utf8'
  );
  assert.match(serviceSource, /AUDIO_EVENT_LEAD_MS = 120/);
});

test('BPM and time signature changes update a running native service', async () => {
  const plugin = createPlugin();
  const engine = new MetronomeEngine({ plugin });
  await engine.start();

  assert.equal(engine.setBpm(999).bpm, MAX_BPM);
  assert.equal(engine.setBpm(-100).bpm, MIN_BPM);
  const state = engine.setTimeSignature(6, 8);
  assert.equal(state.timeSignatureLabel, '6/8');
  assert.deepEqual(state.accentPattern, [2, 0, 0, 1, 0, 0]);

  await flushUpdates();
  await flushUpdates();

  const updates = plugin.calls.filter((call) => call.method === 'update');
  assert.equal(updates.length >= 2, true);
  assert.equal(updates.at(-1).payload.restartPattern, true);
  assert.equal(updates.at(-1).payload.accentPattern, '2,0,0,1,0,0');
});

test('rapid configuration changes coalesce into the latest native update', async () => {
  const plugin = createPlugin();
  const originalUpdate = plugin.update.bind(plugin);
  const gate = createDeferred();
  let holdNextUpdate = false;

  plugin.update = async (payload) => {
    if (holdNextUpdate) {
      await gate.promise;
    }
    return originalUpdate(payload);
  };

  const engine = new MetronomeEngine({ plugin });
  await engine.start();
  holdNextUpdate = true;

  engine.setBpm(130);
  engine.setBpm(140);
  engine.setBpm(150);
  engine.setTimeSignature(6, 8);

  gate.resolve();
  await flushUpdates();
  await flushUpdates();

  const updates = plugin.calls.filter((call) => call.method === 'update');
  assert.equal(updates.length, 2);
  assert.equal(updates.at(-1).payload.bpm, 150);
  assert.equal(updates.at(-1).payload.accentPattern, '2,0,0,1,0,0');
  assert.equal(updates.at(-1).payload.restartPattern, true);
});

test('unsupported signatures leave the current state unchanged', () => {
  const engine = new MetronomeEngine({ plugin: createPlugin() });
  assert.equal(engine.setTimeSignature(6, 4).timeSignatureLabel, '4/4');
  assert.equal(engine.setTimeSignature(4, 2).timeSignatureLabel, '4/4');
});

test('the core proxy contains no WebAudio, timer, or lifecycle-switch logic', async () => {
  const enginePath = fileURLToPath(new URL('../www/metronome-engine.js', import.meta.url));
  const source = await readFile(enginePath, 'utf8');
  assert.equal(source.includes('AudioContext'), false);
  assert.equal(source.includes('webkitAudioContext'), false);
  assert.equal(source.includes('setInterval'), false);
  assert.equal(source.includes('setTimeout'), false);
  assert.equal(source.includes('requestAnimationFrame'), false);
  assert.equal(source.includes('visibilitychange'), false);
  assert.equal(source.includes('pagehide'), false);
});
