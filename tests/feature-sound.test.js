import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SOUND_DEFAULTS,
  SOUND_PRESETS,
  addSoundBeatListener,
  addSoundPreviewBeatListener,
  addSoundPreviewFinishedListener,
  getSoundLevels,
  loadSoundSettings,
  normalizeSoundSettings,
  previewSoundSettings,
  saveSoundSettings,
  updateRunningSoundSettings
} from '../www/feature-sound.js';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

test('sound settings are clamped to their supported ranges', () => {
  const settings = normalizeSoundSettings({
    volume: 99,
    brightness: -1,
    kick: 0,
    snare: 9,
    hat: 1.4
  });

  assert.deepEqual(settings, {
    volume: 10,
    brightness: 0.5,
    kick: 0.5,
    snare: 1.5,
    hat: 1.4
  });
});

test('sound settings persist through the storage adapter', () => {
  const storage = createStorage();
  saveSoundSettings(SOUND_PRESETS.crisp, storage);
  assert.deepEqual(loadSoundSettings(storage), SOUND_PRESETS.crisp);
});

test('the default sound profile remains loud and bright', () => {
  assert.equal(SOUND_DEFAULTS.volume, 5);
  assert.equal(SOUND_DEFAULTS.brightness, 1);
  assert.equal(SOUND_DEFAULTS.kick, 1.5);
  assert.equal(SOUND_DEFAULTS.snare, 1.5);
  assert.equal(SOUND_DEFAULTS.hat, 1);
});

test('the loud preset uses the expanded maximum volume', () => {
  const standard = getSoundLevels({ ...SOUND_DEFAULTS, volume: 5 });
  const maximum = getSoundLevels(SOUND_PRESETS.loud);

  assert.equal(SOUND_PRESETS.loud.volume, 10);
  assert.ok(maximum.kickBody > standard.kickBody * 1.9);
  assert.ok(maximum.snareNoise > standard.snareNoise * 1.9);
});

test('volume and brightness controls produce clearly different native levels', () => {
  const quietDull = getSoundLevels({
    volume: 0.8,
    brightness: 0.5,
    kick: 0.8,
    snare: 0.8,
    hat: 0.8
  });
  const loudBright = getSoundLevels({
    volume: 5,
    brightness: 2,
    kick: 1.3,
    snare: 1.35,
    hat: 1.5
  });

  assert.ok(loudBright.kickBody > quietDull.kickBody * 2);
  assert.ok(loudBright.kickClick > quietDull.kickClick * 2);
  assert.ok(loudBright.snareNoise > quietDull.snareNoise * 2);
  assert.ok(loudBright.hat > quietDull.hat * 3);
  assert.ok(loudBright.hatFrequency > quietDull.hatFrequency + 1000);
  assert.ok(loudBright.highShelfGain > quietDull.highShelfGain + 10);
});

test('6/8 mechanical tone exposes short hits and beat-4 special routing', async () => {
  const [html, nativeSource] = await Promise.all([
    readFile(new URL('../www/sound-settings.html', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/java/com/mobilemetronome/app/BackgroundMetronomeService.java', import.meta.url), 'utf8')
  ]);

  assert.match(html, />响度调节</);
  assert.match(html, />第一拍</);
  assert.match(html, />特殊拍</);
  assert.match(html, />其他拍</);
  assert.match(nativeSource, /MECHANICAL_DING_DURATION = 0\.105/);
  assert.match(nativeSource, /MECHANICAL_DI_DURATION = 0\.030/);
  assert.match(nativeSource, /MECHANICAL_SPECIAL_DURATION = 0\.042/);
  assert.match(nativeSource, /mechanicalDingLevel = 0\.46 \* firstBeatDrive/);
  assert.match(nativeSource, /mechanicalDiLevel = 0\.30 \* otherBeatDrive/);
  assert.match(nativeSource, /mechanicalSpecialLevel = 0\.36 \* specialBeatDrive/);
  assert.match(nativeSource, /mechanicalSpecialFrequency = 1180 \+ brightness \* 200/);
  assert.match(nativeSource, /mechanicalSpecialBodyFrequency = 720 \+ brightness \* 120/);
  assert.match(
    nativeSource,
    /private boolean mechanicalTone = TONE_MECHANICAL\.equals\(toneId\)/
  );
  assert.match(nativeSource, /boolean nextMechanicalTone = TONE_MECHANICAL\.equals\(normalized\)/);
  assert.match(nativeSource, /mechanicalTone == nextMechanicalTone/);
  assert.match(
    nativeSource,
    /currentBeatsPerBar == 6[\s\S]*currentDenominator == 8[\s\S]*beatIndex == 4/
  );
  assert.match(nativeSource, /synth\.trigger\(accentLevel, sixEightSpecialBeat\)/);
  assert.match(nativeSource, /synth\.trigger\(accentLevel, pendingBeatIndex == 3\)/);
});

test('total volume display maps the native 0.5-10 range to 10-200 percent', async () => {
  const [html, settingsSource] = await Promise.all([
    readFile(new URL('../www/sound-settings.html', import.meta.url), 'utf8'),
    readFile(new URL('../www/sound-settings.js', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="volume-value"[^>]*>100%</);
  assert.match(html, /id="volume-slider"[^>]*max="10"[^>]*value="5"[^>]*aria-valuetext="100%"/);
  assert.match(settingsSource, /function formatVolumePercent\(value\)/);
  assert.match(settingsSource, /Math\.round\(value \* 20\)/);
});

test('sound preview is delegated to the native plugin', async () => {
  const previousCapacitor = globalThis.Capacitor;
  const previousStorage = globalThis.localStorage;
  let previewPayload = null;
  globalThis.localStorage = {
    getItem() {
      return 'mechanical';
    }
  };
  globalThis.Capacitor = {
    Plugins: {
      BackgroundMetronome: {
        async preview(payload) {
          previewPayload = payload;
        }
      }
    }
  };

  try {
    await previewSoundSettings(SOUND_PRESETS.crisp);
    assert.deepEqual(previewPayload, {
      ...SOUND_PRESETS.crisp,
      toneId: 'mechanical'
    });
  } finally {
    globalThis.Capacitor = previousCapacitor;
    globalThis.localStorage = previousStorage;
  }
});

test('sound preview reports unavailability without WebAudio fallback', async () => {
  const previousCapacitor = globalThis.Capacitor;
  globalThis.Capacitor = undefined;
  try {
    await assert.rejects(() => previewSoundSettings(SOUND_DEFAULTS), /Android App/);
  } finally {
    globalThis.Capacitor = previousCapacitor;
  }
});

test('live sound updates are delegated to the running native service', async () => {
  const previousCapacitor = globalThis.Capacitor;
  let updatePayload = null;
  globalThis.Capacitor = {
    Plugins: {
      BackgroundMetronome: {
        async updateSound(payload) {
          updatePayload = payload;
        }
      }
    }
  };

  try {
    assert.equal(await updateRunningSoundSettings(SOUND_PRESETS.crisp), true);
    assert.deepEqual(updatePayload, SOUND_PRESETS.crisp);
  } finally {
    globalThis.Capacitor = previousCapacitor;
  }
});

test('live sound updates and beat subscriptions are safe outside Capacitor', async () => {
  const previousCapacitor = globalThis.Capacitor;
  globalThis.Capacitor = undefined;

  try {
    assert.equal(await updateRunningSoundSettings(SOUND_DEFAULTS), false);
    assert.equal(await addSoundBeatListener(() => {}), null);
  } finally {
    globalThis.Capacitor = previousCapacitor;
  }
});

test('beat listener delegates native beat events to the sound page callback', async () => {
  const previousCapacitor = globalThis.Capacitor;
  let received = null;
  let eventName = null;
  const expectedHandle = { async remove() {} };
  globalThis.Capacitor = {
    Plugins: {
      BackgroundMetronome: {
        async addListener(name, listener) {
          eventName = name;
          listener({ beatIndex: 4 });
          return expectedHandle;
        }
      }
    }
  };

  try {
    const handle = await addSoundBeatListener((payload) => {
      received = payload;
    });
    assert.equal(eventName, 'beat');
    assert.deepEqual(received, { beatIndex: 4 });
    assert.equal(handle, expectedHandle);
  } finally {
    globalThis.Capacitor = previousCapacitor;
  }
});

test('preview events expose the same audible timestamp as their sound', async () => {
  const previousCapacitor = globalThis.Capacitor;
  const listeners = new Map();
  globalThis.Capacitor = {
    Plugins: {
      BackgroundMetronome: {
        async addListener(name, listener) {
          listeners.set(name, listener);
          return { async remove() {} };
        }
      }
    }
  };

  try {
    let previewBeat = null;
    let previewFinished = false;
    await addSoundPreviewBeatListener((payload) => {
      previewBeat = payload;
    });
    await addSoundPreviewFinishedListener(() => {
      previewFinished = true;
    });

    listeners.get('previewBeat')({ beatIndex: 3, audibleAtEpochMs: 123456 });
    listeners.get('previewFinished')({ completed: true });

    assert.deepEqual(previewBeat, { beatIndex: 3, audibleAtEpochMs: 123456 });
    assert.equal(previewFinished, true);
  } finally {
    globalThis.Capacitor = previousCapacitor;
  }
});

test('the sound page drives preview dots and completion from native events', async () => {
  const [pageSource, pluginSource, serviceSource] = await Promise.all([
    readFile(new URL('../www/sound-settings.js', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/java/com/mobilemetronome/app/BackgroundMetronomePlugin.java', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/java/com/mobilemetronome/app/BackgroundMetronomeService.java', import.meta.url), 'utf8')
  ]);
  assert.match(pageSource, /addSoundPreviewBeatListener/);
  assert.match(pageSource, /schedulePreviewBeat\(payload/);
  assert.match(pageSource, /addSoundPreviewFinishedListener/);
  assert.match(pageSource, /waitForPreviewFinished/);
  assert.equal(pageSource.includes('startPreviewAnimation'), false);
  assert.match(pluginSource, /public void updateSound\(PluginCall call\)/);
  assert.match(pluginSource, /audibleAtEpochMs/);
  assert.equal(pluginSource.includes('notifyOnMainThread("previewBeat", payload)'), true);
  assert.match(serviceSource, /announcePreviewBeats/);
});
