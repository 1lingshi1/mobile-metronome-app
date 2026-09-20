import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleAtAudibleTime } from '../www/beat-sync.js';

function createFrameDriver(nowRef) {
  let nextHandle = 1;
  const callbacks = new Map();
  const cancelled = new Set();

  return {
    callbacks,
    cancelled,
    now() {
      return nowRef.value;
    },
    requestAnimationFrame(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) {
      cancelled.add(handle);
      callbacks.delete(handle);
    },
    runNext(frameTime) {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, 'expected a scheduled animation frame');
      const [handle, callback] = entry;
      callbacks.delete(handle);
      callback(frameTime);
      return handle;
    }
  };
}

test('visual updates without an audible timestamp run immediately', () => {
  let calls = 0;
  const cancel = scheduleAtAudibleTime(undefined, () => {
    calls += 1;
  });

  assert.equal(calls, 1);
  cancel();
  assert.equal(calls, 1);
});

test('near-term audio events activate immediately instead of missing the target', () => {
  let calls = 0;
  scheduleAtAudibleTime(5, () => {
    calls += 1;
  }, {
    now: () => 0,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {}
  });

  assert.equal(calls, 1);
});

test('visual updates use the animation frame nearest the audible time', () => {
  const nowRef = { value: 0 };
  const frames = createFrameDriver(nowRef);
  let calls = 0;
  const cancel = scheduleAtAudibleTime(50, () => {
    calls += 1;
  }, {
    now: frames.now,
    requestAnimationFrame: frames.requestAnimationFrame,
    cancelAnimationFrame: frames.cancelAnimationFrame
  });

  assert.equal(calls, 0);
  frames.runNext(0);
  nowRef.value = 16;
  frames.runNext(16);
  nowRef.value = 32;
  frames.runNext(32);
  assert.equal(calls, 0);

  nowRef.value = 48;
  frames.runNext(48);
  assert.equal(calls, 1);
  cancel();
});

test('cancelling a scheduled visual update prevents stale beat highlighting', () => {
  const nowRef = { value: 0 };
  const frames = createFrameDriver(nowRef);
  let calls = 0;
  const cancel = scheduleAtAudibleTime(100, () => {
    calls += 1;
  }, {
    now: frames.now,
    requestAnimationFrame: frames.requestAnimationFrame,
    cancelAnimationFrame: frames.cancelAnimationFrame
  });

  cancel();
  assert.equal(frames.cancelled.size, 1);
  assert.equal(calls, 0);
});
