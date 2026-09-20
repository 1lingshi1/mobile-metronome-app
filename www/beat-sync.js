const BEAT_RENDER_TOLERANCE_MS = 1.5;
const DEFAULT_FRAME_DURATION_MS = 1000 / 60;
const MIN_FRAME_DURATION_MS = 8;
const MAX_FRAME_DURATION_MS = 34;

export function scheduleAtAudibleTime(audibleAtEpochMs, callback, options = {}) {
  if (typeof callback !== 'function') {
    throw new TypeError('Beat visual callback must be a function.');
  }

  const now = typeof options.now === 'function' ? options.now : Date.now;
  const requestFrame = options.requestAnimationFrame || (
    typeof globalThis.requestAnimationFrame === 'function'
      ? (callback) => globalThis.requestAnimationFrame(callback)
      : null
  );
  const cancelFrame = options.cancelAnimationFrame || (
    typeof globalThis.cancelAnimationFrame === 'function'
      ? (handle) => globalThis.cancelAnimationFrame(handle)
      : null
  );
  const targetEpochMs = Number(audibleAtEpochMs);

  if (
    !Number.isFinite(targetEpochMs) ||
    typeof requestFrame !== 'function'
  ) {
    callback();
    return () => {};
  }

  const initialDelayMs = targetEpochMs - now();
  if (
    initialDelayMs <= Math.max(
      BEAT_RENDER_TOLERANCE_MS,
      DEFAULT_FRAME_DURATION_MS / 2
    )
  ) {
    callback();
    return () => {};
  }

  let frameHandle = 0;
  let previousFrameTime = 0;
  let frameDurationMs = DEFAULT_FRAME_DURATION_MS;
  let cancelled = false;

  const waitForAudibleTime = (frameTime) => {
    if (cancelled) {
      return;
    }

    if (previousFrameTime > 0) {
      const measuredFrameDuration = frameTime - previousFrameTime;
      if (
        measuredFrameDuration >= MIN_FRAME_DURATION_MS &&
        measuredFrameDuration <= MAX_FRAME_DURATION_MS
      ) {
        frameDurationMs = measuredFrameDuration;
      }
    }
    previousFrameTime = frameTime;

    const remainingMs = targetEpochMs - now();
    if (remainingMs <= Math.max(BEAT_RENDER_TOLERANCE_MS, frameDurationMs / 2)) {
      frameHandle = 0;
      callback();
      return;
    }

    frameHandle = requestFrame(waitForAudibleTime);
  };

  frameHandle = requestFrame(waitForAudibleTime);

  return () => {
    cancelled = true;
    if (frameHandle && typeof cancelFrame === 'function') {
      cancelFrame(frameHandle);
    }
    frameHandle = 0;
  };
}
