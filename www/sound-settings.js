import { applyStoredBackground } from './feature-background.js';
import { scheduleAtAudibleTime } from './beat-sync.js';
import { installSettingsSwipe } from './feature-settings-swipe.js';
import { installSafeSliders } from './feature-safe-slider.js';
import {
  SOUND_DEFAULTS,
  SOUND_PRESETS,
  addSoundBeatListener,
  addSoundPreviewBeatListener,
  addSoundPreviewFinishedListener,
  loadSoundSettings,
  normalizeSoundSettings,
  previewSoundSettings,
  saveSoundSettings,
  updateRunningSoundSettings
} from './feature-sound.js';

applyStoredBackground();

const SOUND_SAVE_DELAY_MS = 120;
const SOUND_LIVE_UPDATE_DELAY_MS = 80;
const PREVIEW_TIMEOUT_MS = 5000;
const elements = {
  volumeSlider: getElement('volume-slider'),
  brightnessSlider: getElement('brightness-slider'),
  kickSlider: getElement('kick-slider'),
  snareSlider: getElement('snare-slider'),
  hatSlider: getElement('hat-slider'),
  volumeValue: getElement('volume-value'),
  brightnessValue: getElement('brightness-value'),
  kickValue: getElement('kick-value'),
  snareValue: getElement('snare-value'),
  hatValue: getElement('hat-value'),
  resetButton: getElement('reset-sound'),
  previewButton: getElement('preview-sound'),
  previewLabel: getElement('preview-sound-label'),
  previewDots: Array.from(document.querySelectorAll('.preview-dot')),
  presetButtons: Array.from(document.querySelectorAll('.preset-button'))
};

let settings = loadSoundSettings();
let previewing = false;
let saveTimer = 0;
let liveUpdateTimer = 0;
let pendingLiveSettings = null;
let previewFinishedResolve = null;
let previewBeatHandle = null;
let previewEventHandle = null;
let previewFinishedHandle = null;
let cancelScheduledPreviewBeat = null;

function getElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`缺少音色设置元素：#${id}`);
  }
  return element;
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatVolumePercent(value) {
  return `${Math.round(value * 20)}%`;
}

function updateSliderProgress(slider) {
  const minimum = Number(slider.min);
  const maximum = Number(slider.max);
  const value = Number(slider.value);
  const progress = ((value - minimum) / (maximum - minimum)) * 100;
  slider.style.setProperty('--slider-progress', `${progress}%`);
}

const controls = [
  { key: 'volume', slider: elements.volumeSlider, output: elements.volumeValue, format: formatVolumePercent },
  { key: 'brightness', slider: elements.brightnessSlider, output: elements.brightnessValue, format: formatPercent },
  { key: 'kick', slider: elements.kickSlider, output: elements.kickValue, format: formatPercent },
  { key: 'snare', slider: elements.snareSlider, output: elements.snareValue, format: formatPercent },
  { key: 'hat', slider: elements.hatSlider, output: elements.hatValue, format: formatPercent }
];

function readSettings() {
  return normalizeSoundSettings({
    volume: elements.volumeSlider.value,
    brightness: elements.brightnessSlider.value,
    kick: elements.kickSlider.value,
    snare: elements.snareSlider.value,
    hat: elements.hatSlider.value
  });
}

function renderControl(control) {
  const value = settings[control.key];
  const formattedValue = control.format(value);
  control.slider.value = String(value);
  control.output.textContent = formattedValue;
  control.slider.setAttribute('aria-valuetext', formattedValue);
  updateSliderProgress(control.slider);
}

function render() {
  controls.forEach(renderControl);
  updatePresetState();
}

function updatePresetState() {
  elements.presetButtons.forEach((button) => {
    const preset = SOUND_PRESETS[button.dataset.preset];
    const matches = Object.keys(preset).every((key) => Math.abs(preset[key] - settings[key]) < 0.001);
    button.classList.toggle('is-active', matches);
    button.setAttribute('aria-pressed', matches ? 'true' : 'false');
  });
}

function commitSoundSettings() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = 0;
  }
  settings = saveSoundSettings(settings);
  flushLiveSoundSettings();
}

function flushLiveSoundSettings() {
  if (liveUpdateTimer) {
    clearTimeout(liveUpdateTimer);
    liveUpdateTimer = 0;
  }

  const nextSettings = pendingLiveSettings || settings;
  pendingLiveSettings = null;
  updateRunningSoundSettings(nextSettings).catch((error) => {
    globalThis.console.error('实时更新节拍器音色失败。', error);
  });
}

function scheduleLiveSoundSettingsUpdate() {
  pendingLiveSettings = settings;
  if (liveUpdateTimer) {
    return;
  }

  liveUpdateTimer = setTimeout(() => {
    liveUpdateTimer = 0;
    flushLiveSoundSettings();
  }, SOUND_LIVE_UPDATE_DELAY_MS);
}

function scheduleSoundSettingsCommit() {
  if (saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    commitSoundSettings();
  }, SOUND_SAVE_DELAY_MS);
}

function updateFromSlider(control) {
  settings = normalizeSoundSettings({
    ...settings,
    [control.key]: control.slider.value
  });
  renderControl(control);
  updatePresetState();
  scheduleLiveSoundSettingsUpdate();
  scheduleSoundSettingsCommit();
}

function setPreviewBeat(index) {
  elements.previewDots.forEach((dot, dotIndex) => {
    dot.classList.toggle('is-active', dotIndex === index);
  });
}

function cancelPreviewBeatSchedule() {
  if (cancelScheduledPreviewBeat) {
    cancelScheduledPreviewBeat();
    cancelScheduledPreviewBeat = null;
  }
}

function schedulePreviewBeat(payload, index) {
  cancelPreviewBeatSchedule();
  cancelScheduledPreviewBeat = scheduleAtAudibleTime(payload.audibleAtEpochMs, () => {
    cancelScheduledPreviewBeat = null;
    setPreviewBeat(index);
  });
}

function finishPreview() {
  cancelPreviewBeatSchedule();
  const resolve = previewFinishedResolve;
  previewFinishedResolve = null;
  if (resolve) {
    resolve();
  }
}

function waitForPreviewFinished() {
  finishPreview();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      previewFinishedResolve = null;
      resolve();
    }, PREVIEW_TIMEOUT_MS);

    previewFinishedResolve = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

addSoundBeatListener((payload) => {
  if (previewing) {
    return;
  }

  const beatIndex = Math.round(Number(payload && payload.beatIndex));
  if (!Number.isFinite(beatIndex) || beatIndex < 1) {
    return;
  }

  schedulePreviewBeat(payload, (beatIndex - 1) % elements.previewDots.length);
}).then((handle) => {
  previewBeatHandle = handle;
}).catch((error) => {
  globalThis.console.error('订阅原生拍点预览失败。', error);
});

addSoundPreviewBeatListener((payload) => {
  if (!previewing) {
    return;
  }

  const beatIndex = Math.round(Number(payload && payload.beatIndex));
  if (!Number.isFinite(beatIndex) || beatIndex < 1) {
    return;
  }

  schedulePreviewBeat(payload, (beatIndex - 1) % elements.previewDots.length);
}).then((handle) => {
  previewEventHandle = handle;
}).catch((error) => {
  globalThis.console.error('Preview beat subscription failed.', error);
});

addSoundPreviewFinishedListener(() => {
  finishPreview();
}).then((handle) => {
  previewFinishedHandle = handle;
}).catch((error) => {
  globalThis.console.error('Preview completion subscription failed.', error);
});

controls.forEach((control) => {
  control.slider.addEventListener('input', () => updateFromSlider(control));
  control.slider.addEventListener('change', commitSoundSettings);
});

elements.presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    settings = saveSoundSettings(SOUND_PRESETS[button.dataset.preset]);
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    render();
    flushLiveSoundSettings();
  });
});

elements.resetButton.addEventListener('click', () => {
  settings = saveSoundSettings(SOUND_DEFAULTS);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = 0;
  }
  render();
  cancelPreviewBeatSchedule();
  setPreviewBeat(-1);
  flushLiveSoundSettings();
});

elements.previewButton.addEventListener('click', async () => {
  if (previewing) {
    return;
  }

  previewing = true;
  elements.previewButton.disabled = true;
  elements.previewLabel.textContent = '试听中…';
  settings = readSettings();
  commitSoundSettings();
  cancelPreviewBeatSchedule();
  setPreviewBeat(-1);
  const previewFinished = waitForPreviewFinished();

  try {
    await previewSoundSettings(settings);
    await previewFinished;
  } catch (error) {
    finishPreview();
    globalThis.console.error('音色试听失败。', error);
  } finally {
    cancelPreviewBeatSchedule();
    setPreviewBeat(-1);
    previewing = false;
    elements.previewButton.disabled = false;
    elements.previewLabel.textContent = '试听音色';
  }
});

globalThis.addEventListener('pagehide', () => {
  finishPreview();
  commitSoundSettings();
  [previewBeatHandle, previewEventHandle, previewFinishedHandle].forEach((handle) => {
    if (handle && typeof handle.remove === 'function') {
      void handle.remove();
    }
  });
  previewBeatHandle = null;
  previewEventHandle = null;
  previewFinishedHandle = null;
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    commitSoundSettings();
  }
});

render();
installSafeSliders([
  elements.volumeSlider,
  elements.brightnessSlider,
  elements.kickSlider,
  elements.snareSlider,
  elements.hatSlider
]);
installSettingsSwipe({
  direction: 'left',
  target: './more-settings.html'
});
