import { loadSelectedTone } from './feature-tone-selector.js';

const STORAGE_KEY = 'metronome-sound-settings-v9';
const FEATURE_NAME = 'native-tunable-drum-sound';

export const SOUND_DEFAULTS = Object.freeze({
  volume: 5,
  brightness: 1,
  kick: 1.5,
  snare: 1.5,
  hat: 1
});

export const SOUND_PRESETS = Object.freeze({
  loud: Object.freeze({ volume: 10, brightness: 1, kick: 1.5, snare: 1.5, hat: 1 }),
  crisp: Object.freeze({ volume: 4.5, brightness: 1.4, kick: 1.1, snare: 1.3, hat: 1.4 }),
  punchy: Object.freeze({ volume: 5, brightness: 0.8, kick: 1.5, snare: 1.5, hat: 0.8 })
});

const LIMITS = Object.freeze({
  volume: Object.freeze({ minimum: 0.5, maximum: 10 }),
  brightness: Object.freeze({ minimum: 0.5, maximum: 2 }),
  kick: Object.freeze({ minimum: 0.5, maximum: 1.5 }),
  snare: Object.freeze({ minimum: 0.5, maximum: 1.5 }),
  hat: Object.freeze({ minimum: 0.5, maximum: 1.5 })
});

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, number));
}

function getBackgroundPlugin() {
  const capacitor = globalThis.Capacitor;
  if (!capacitor || !capacitor.Plugins) {
    return null;
  }
  return capacitor.Plugins.BackgroundMetronome || null;
}

export function normalizeSoundSettings(settings = {}) {
  return {
    volume: clamp(settings.volume, LIMITS.volume.minimum, LIMITS.volume.maximum, SOUND_DEFAULTS.volume),
    brightness: clamp(settings.brightness, LIMITS.brightness.minimum, LIMITS.brightness.maximum, SOUND_DEFAULTS.brightness),
    kick: clamp(settings.kick, LIMITS.kick.minimum, LIMITS.kick.maximum, SOUND_DEFAULTS.kick),
    snare: clamp(settings.snare, LIMITS.snare.minimum, LIMITS.snare.maximum, SOUND_DEFAULTS.snare),
    hat: clamp(settings.hat, LIMITS.hat.minimum, LIMITS.hat.maximum, SOUND_DEFAULTS.hat)
  };
}

export function getSoundLevels(settings = {}) {
  const normalized = normalizeSoundSettings(settings);
  const kickDrive = normalized.volume * normalized.kick;
  const snareDrive = normalized.volume * normalized.snare;
  const hatDrive = normalized.volume * normalized.hat;

  return {
    kickBody: 0.85 * kickDrive,
    kickClick: 0.05 * kickDrive * (0.8 + normalized.brightness * 0.3),
    kickClickFrequency: 900 + normalized.brightness * 600,
    kickPresence: 0.03 * kickDrive * (0.8 + normalized.brightness * 0.3),
    kickPresenceFrequency: 3500 + normalized.brightness * 800,
    downbeatTom: 0.55 * kickDrive,
    downbeatTomFrequency: 105 + normalized.brightness * 10,
    snareTone: 0.45 * snareDrive,
    snareNoise: 0.32 * snareDrive,
    snareNoiseFrequency: 1400 + normalized.brightness * 800,
    hat: 0.18 * hatDrive,
    hatFrequency: 5000 + normalized.brightness * 1200,
    highShelfGain: (normalized.brightness - 1) * 8
  };
}

export function loadSoundSettings(storage = globalThis.localStorage) {
  if (!storage) {
    return normalizeSoundSettings(SOUND_DEFAULTS);
  }

  try {
    const stored = storage.getItem(STORAGE_KEY);
    return stored ? normalizeSoundSettings(JSON.parse(stored)) : normalizeSoundSettings(SOUND_DEFAULTS);
  } catch (error) {
    return normalizeSoundSettings(SOUND_DEFAULTS);
  }
}

export function saveSoundSettings(settings, storage = globalThis.localStorage) {
  const normalized = normalizeSoundSettings(settings);
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (error) {
      // Settings remain active for the current page if storage is unavailable.
    }
  }
  return normalized;
}

export async function previewSoundSettings(settings) {
  const plugin = getBackgroundPlugin();
  if (!plugin || typeof plugin.preview !== 'function') {
    throw new Error('原生音色试听仅在 Android App 中可用。');
  }
  return plugin.preview({
    ...normalizeSoundSettings(settings),
    toneId: loadSelectedTone()
  });
}

export async function updateRunningSoundSettings(settings) {
  const plugin = getBackgroundPlugin();
  if (!plugin || typeof plugin.updateSound !== 'function') {
    return false;
  }

  await plugin.updateSound(normalizeSoundSettings(settings));
  return true;
}

async function addNativeEventListener(eventName, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Native event listener must be a function.');
  }

  const plugin = getBackgroundPlugin();
  if (!plugin || typeof plugin.addListener !== 'function') {
    return null;
  }

  return plugin.addListener(eventName, listener);
}

export function addSoundBeatListener(listener) {
  return addNativeEventListener('beat', listener);
}

export function addSoundPreviewBeatListener(listener) {
  return addNativeEventListener('previewBeat', listener);
}

export function addSoundPreviewFinishedListener(listener) {
  return addNativeEventListener('previewFinished', listener);
}
export { STORAGE_KEY, FEATURE_NAME };
