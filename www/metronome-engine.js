const DEFAULT_BPM = 120;
const MIN_BPM = 30;
const MAX_BPM = 350;
const MIN_BEATS_PER_BAR = 2;
const MAX_BEATS_PER_BAR = 12;
const SUPPORTED_TIME_SIGNATURES = Object.freeze([
  Object.freeze({ numerator: 2, denominator: 4 }),
  Object.freeze({ numerator: 3, denominator: 4 }),
  Object.freeze({ numerator: 4, denominator: 4 }),
  Object.freeze({ numerator: 6, denominator: 8 }),
  Object.freeze({ numerator: 9, denominator: 8 }),
  Object.freeze({ numerator: 12, denominator: 8 }),
  Object.freeze({ numerator: 5, denominator: 4 }),
  Object.freeze({ numerator: 7, denominator: 4 })
]);

function findTimeSignature(numerator, denominator) {
  return SUPPORTED_TIME_SIGNATURES.find((signature) => (
    signature.numerator === numerator && signature.denominator === denominator
  ));
}

function createAccentPattern(numerator, denominator) {
  const pattern = new Array(numerator).fill(0);
  pattern[0] = 2;

  const isCompoundMeter = denominator === 8 && (numerator === 6 || numerator === 9 || numerator === 12);
  if (isCompoundMeter) {
    for (let index = 3; index < numerator; index += 3) {
      pattern[index] = 1;
    }
  }

  return pattern;
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function parseAccentPattern(value, fallback) {
  if (Array.isArray(value)) {
    return fallback.map((level, index) => clampInteger(value[index], 0, 2, level));
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return fallback.slice();
  }

  const levels = value.split(',').map((entry) => Number(entry.trim()));
  return fallback.map((level, index) => clampInteger(levels[index], 0, 2, level));
}

function getPlugin() {
  const capacitor = globalThis.Capacitor;
  if (!capacitor || !capacitor.Plugins) {
    return null;
  }
  return capacitor.Plugins.BackgroundMetronome || null;
}

export class MetronomeEngine {
  constructor(options = {}) {
    const pluginWasProvided = Object.prototype.hasOwnProperty.call(options, 'plugin');
    this._plugin = pluginWasProvided ? options.plugin : getPlugin();
    this._getSoundSettings = typeof options.getSoundSettings === 'function'
      ? options.getSoundSettings
      : () => ({});
    this._listeners = {
      beat: new Set(),
      stop: new Set(),
      reset: new Set(),
      state: new Set()
    };
    this._pluginHandles = [];
    this._updatePending = null;
    this._updateRunning = false;
    this._initialized = false;
    this._ignoreStoppedSnapshot = false;
    this._acceptNativeBeat = false;

    this._bpm = DEFAULT_BPM;
    this._beatsPerBar = 4;
    this._timeSignature = { numerator: 4, denominator: 4 };
    this._accentPattern = createAccentPattern(4, 4);
    this._beatIndex = 1;
    this._nextBeatIndex = 2;
    this._running = false;
    this._status = 'stopped';
  }

  getState() {
    return {
      bpm: this._bpm,
      beatsPerBar: this._beatsPerBar,
      beatIndex: this._beatIndex,
      nextBeatIndex: this._nextBeatIndex,
      timeSignature: {
        numerator: this._timeSignature.numerator,
        denominator: this._timeSignature.denominator
      },
      timeSignatureLabel: `${this._timeSignature.numerator}/${this._timeSignature.denominator}`,
      accentPattern: this._accentPattern.slice(),
      isRunning: this._running,
      status: this._status
    };
  }

  onBeat(listener) {
    return this._subscribe('beat', listener);
  }

  onStop(listener) {
    return this._subscribe('stop', listener);
  }

  onReset(listener) {
    return this._subscribe('reset', listener);
  }

  onState(listener) {
    return this._subscribe('state', listener);
  }

  async initialize() {
    if (this._initialized) {
      return this.getState();
    }
    this._initialized = true;

    const plugin = this._plugin;
    if (!plugin) {
      return this.getState();
    }

    await this._attachNativeListeners(plugin);

    try {
      const snapshot = await plugin.getState();
      this._applySnapshot(snapshot);
      this._acceptNativeBeat = this._running;
      this._ignoreStoppedSnapshot = false;
      if (this._running) {
        await this._sendUpdate(false);
      }
      this._emit('state', this.getState());
    } catch (error) {
      this._emitError(error);
    }

    return this.getState();
  }

  async syncState() {
    if (!this._plugin || typeof this._plugin.getState !== 'function') {
      return this.getState();
    }

    try {
      const snapshot = await this._plugin.getState();
      this._applySnapshot(snapshot);
      this._acceptNativeBeat = this._running;
      this._ignoreStoppedSnapshot = false;
      if (this._running) {
        await this._sendUpdate(false);
      }
      this._emit('state', this.getState());
    } catch (error) {
      this._emitError(error);
    }
    return this.getState();
  }

  async start() {
    const plugin = this._requirePlugin();
    const stateBeforeStart = this.getState();
    if (this._status === 'paused' || this._beatIndex !== 1) {
      this._beatIndex = this._nextBeatIndex;
      this._nextBeatIndex = this._beatIndex >= this._beatsPerBar ? 1 : this._beatIndex + 1;
    }
    this._running = true;
    this._status = 'running';
    this._acceptNativeBeat = true;
    this._ignoreStoppedSnapshot = false;

    try {
      const snapshot = await plugin.start(this._buildPayload(false));
      this._applySnapshot(snapshot, 'running');
      this._running = true;
      this._status = 'running';
      this._emit('state', this.getState());
      return this.getState();
    } catch (error) {
      this._running = stateBeforeStart.isRunning;
      this._status = stateBeforeStart.status;
      throw error;
    }
  }

  async pause(reason = 'pause') {
    if (!this._running && this._status !== 'running') {
      return this.getState();
    }

    this._ignoreStoppedSnapshot = true;

    try {
      if (this._plugin) {
        await this._invokeNative('pause', () => (
          typeof this._plugin.pause === 'function' ? this._plugin.pause() : this._plugin.stop()
        ));
      }
    } catch (error) {
      this._ignoreStoppedSnapshot = false;
      throw error;
    }

    this._running = false;
    this._status = 'paused';
    this._acceptNativeBeat = false;
    const state = this.getState();
    this._emit('stop', { reason, state });
    this._emit('state', state);
    return state;
  }

  async reset() {
    this._ignoreStoppedSnapshot = true;

    try {
      if (this._plugin) {
        await this._invokeNative('reset', () => (
          typeof this._plugin.reset === 'function' ? this._plugin.reset() : this._plugin.stop()
        ));
      }
    } catch (error) {
      this._ignoreStoppedSnapshot = false;
      throw error;
    }

    this._running = false;
    this._status = 'stopped';
    this._acceptNativeBeat = false;
    this._beatIndex = 1;
    this._nextBeatIndex = 2;
    const state = this.getState();
    this._emit('reset', { beatIndex: 1, state });
    this._emit('state', state);
    return state;
  }

  setBpm(value) {
    const nextBpm = clampInteger(value, MIN_BPM, MAX_BPM, this._bpm);
    if (nextBpm === this._bpm) {
      return this.getState();
    }

    this._bpm = nextBpm;
    if (this._running) {
      this._queueUpdate(false);
    }
    return this.getState();
  }

  setTimeSignature(numerator, denominator) {
    const nextNumerator = clampInteger(numerator, MIN_BEATS_PER_BAR, MAX_BEATS_PER_BAR, this._beatsPerBar);
    const nextDenominator = clampInteger(denominator, 4, 8, this._timeSignature.denominator);
    const nextSignature = findTimeSignature(nextNumerator, nextDenominator);

    if (!nextSignature) {
      return this.getState();
    }

    if (
      nextSignature.numerator === this._timeSignature.numerator &&
      nextSignature.denominator === this._timeSignature.denominator
    ) {
      return this.getState();
    }

    this._timeSignature = {
      numerator: nextSignature.numerator,
      denominator: nextSignature.denominator
    };
    this._beatsPerBar = nextSignature.numerator;
    this._accentPattern = createAccentPattern(nextSignature.numerator, nextSignature.denominator);
    this._beatIndex = 1;
    this._nextBeatIndex = 2;

    if (this._running) {
      this._queueUpdate(true);
    }
    return this.getState();
  }

  setBeatsPerBar(value) {
    const nextBeatsPerBar = clampInteger(value, MIN_BEATS_PER_BAR, MAX_BEATS_PER_BAR, this._beatsPerBar);
    return this.setTimeSignature(nextBeatsPerBar, 4);
  }

  destroy() {
    this._updatePending = null;
    this._pluginHandles.splice(0).forEach((handle) => {
      if (handle && typeof handle.remove === 'function') {
        try {
          const removal = handle.remove();
          if (removal && typeof removal.catch === 'function') {
            removal.catch((error) => this._emitError(error));
          }
        } catch (error) {
          this._emitError(error);
        }
      }
    });
    Object.values(this._listeners).forEach((listeners) => listeners.clear());
  }

  async _attachNativeListeners(plugin) {
    if (typeof plugin.addListener !== 'function') {
      return;
    }

    try {
      const beatHandle = await plugin.addListener('beat', (payload) => this._handleNativeBeat(payload));
      const stateHandle = await plugin.addListener('state', (payload) => this._handleNativeState(payload));
      this._pluginHandles.push(beatHandle, stateHandle);
    } catch (error) {
      this._emitError(error);
    }
  }

  _handleNativeBeat(payload = {}) {
    if (!this._acceptNativeBeat) {
      return;
    }

    const beatsPerBar = clampInteger(payload.beatsPerBar, MIN_BEATS_PER_BAR, MAX_BEATS_PER_BAR, this._beatsPerBar);
    const denominator = clampInteger(payload.denominator, 4, 8, this._timeSignature.denominator);
    const signature = findTimeSignature(beatsPerBar, denominator);

    if (signature) {
      this._beatsPerBar = beatsPerBar;
      this._timeSignature = { ...signature };
      this._accentPattern = parseAccentPattern(
        payload.accentPattern,
        createAccentPattern(beatsPerBar, denominator)
      );
    }

    this._beatIndex = clampInteger(payload.beatIndex, 1, this._beatsPerBar, this._beatIndex);
    this._nextBeatIndex = this._beatIndex >= this._beatsPerBar ? 1 : this._beatIndex + 1;
    this._running = true;
    this._status = 'running';

    const beatPayload = {
      beatIndex: this._beatIndex,
      beatsPerBar: this._beatsPerBar,
      timeSignature: { ...this._timeSignature },
      isDownbeat: this._beatIndex === 1,
      isAccent: Number(payload.accentLevel) > 0,
      accentLevel: clampInteger(
        payload.accentLevel,
        0,
        2,
        this._accentPattern[this._beatIndex - 1] || 0
      )
    };
    const audibleAtEpochMs = Number(payload.audibleAtEpochMs);
    if (Number.isFinite(audibleAtEpochMs)) {
      beatPayload.audibleAtEpochMs = audibleAtEpochMs;
    }
    this._emit('beat', beatPayload);
  }

  _handleNativeState(payload = {}) {
    const wasRunning = this._running;

    if (payload.running === false && this._ignoreStoppedSnapshot) {
      this._running = false;
      this._status = this._status === 'running' ? 'stopped' : this._status;
      this._acceptNativeBeat = false;
      this._emit('state', this.getState());
      return;
    }

    this._applySnapshot(payload);
    this._acceptNativeBeat = this._running;
    if (this._running) {
      this._ignoreStoppedSnapshot = false;
    }

    if (wasRunning && !this._running) {
      this._status = 'stopped';
      const state = this.getState();
      this._emit('stop', { reason: 'native', state });
    }

    this._emit('state', this.getState());
  }

  _applySnapshot(snapshot = {}, statusOverride = null) {
    this._bpm = clampInteger(snapshot.bpm, MIN_BPM, MAX_BPM, this._bpm);
    const beatsPerBar = clampInteger(
      snapshot.beatsPerBar,
      MIN_BEATS_PER_BAR,
      MAX_BEATS_PER_BAR,
      this._beatsPerBar
    );
    const denominator = clampInteger(snapshot.denominator, 4, 8, this._timeSignature.denominator);
    const signature = findTimeSignature(beatsPerBar, denominator) || this._timeSignature;

    this._beatsPerBar = signature.numerator;
    this._timeSignature = { ...signature };
    this._accentPattern = parseAccentPattern(
      snapshot.accentPattern,
      snapshot.beatsPerBar === undefined
        ? this._accentPattern
        : createAccentPattern(signature.numerator, signature.denominator)
    );
    this._beatIndex = clampInteger(snapshot.beatIndex, 1, this._beatsPerBar, this._beatIndex);
    this._nextBeatIndex = clampInteger(
      snapshot.nextBeatIndex,
      1,
      this._beatsPerBar,
      this._beatIndex >= this._beatsPerBar ? 1 : this._beatIndex + 1
    );

    if (typeof snapshot.running === 'boolean') {
      this._running = snapshot.running;
    }

    if (statusOverride) {
      this._status = statusOverride;
    } else if (this._running) {
      this._status = 'running';
    } else if (this._status === 'running') {
      this._status = 'stopped';
    }
  }

  _buildPayload(restartPattern) {
    const soundSettings = this._getSoundSettings() || {};
    return {
      bpm: this._bpm,
      beatsPerBar: this._beatsPerBar,
      denominator: this._timeSignature.denominator,
      currentBeatIndex: this._beatIndex,
      nextBeatIndex: this._nextBeatIndex,
      accentPattern: this._accentPattern.join(','),
      restartPattern: Boolean(restartPattern),
      volume: soundSettings.volume,
      brightness: soundSettings.brightness,
      kick: soundSettings.kick,
      snare: soundSettings.snare,
      hat: soundSettings.hat
    };
  }

  _queueUpdate(restartPattern) {
    const payload = this._buildPayload(restartPattern);
    if (this._updatePending) {
      payload.restartPattern = Boolean(
        this._updatePending.restartPattern || payload.restartPattern
      );
    }
    this._updatePending = payload;

    if (!this._updateRunning) {
      void this._drainUpdateQueue();
    }
  }

  async _drainUpdateQueue() {
    this._updateRunning = true;

    try {
      while (this._updatePending !== null) {
        const payload = this._updatePending;
        this._updatePending = null;

        try {
          await this._sendUpdatePayload(payload);
        } catch (error) {
          this._emitError(error);
        }
      }
    } finally {
      this._updateRunning = false;
    }
  }

  _sendUpdate(restartPattern) {
    return this._sendUpdatePayload(this._buildPayload(restartPattern));
  }

  async _sendUpdatePayload(payload) {
    if (!this._plugin || typeof this._plugin.update !== 'function') {
      return null;
    }
    const snapshot = await this._plugin.update(payload);
    if (snapshot) {
      this._applySnapshot(snapshot, 'running');
      this._running = true;
      this._status = 'running';
      this._acceptNativeBeat = true;
      this._ignoreStoppedSnapshot = false;
    }
    return snapshot;
  }

  async _invokeNative(operation, callback) {
    try {
      return await callback();
    } catch (error) {
      this._emitError(error);
      throw new Error(`原生节拍器 ${operation} 失败。`, { cause: error });
    }
  }

  _requirePlugin() {
    if (!this._plugin) {
      throw new Error('Android 原生节拍器插件不可用，请在 Capacitor App 中运行。');
    }
    return this._plugin;
  }

  _subscribe(type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('事件监听器必须是函数。');
    }
    const listeners = this._listeners[type];
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  _emit(type, payload) {
    this._listeners[type].forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        this._emitError(error);
      }
    });
  }

  _emitError(error) {
    if (globalThis.console && typeof globalThis.console.error === 'function') {
      globalThis.console.error('原生节拍器代理执行失败。', error);
    }
  }
}

export {
  DEFAULT_BPM,
  MIN_BPM,
  MAX_BPM,
  MIN_BEATS_PER_BAR,
  MAX_BEATS_PER_BAR,
  SUPPORTED_TIME_SIGNATURES,
  createAccentPattern
};
export default MetronomeEngine;
