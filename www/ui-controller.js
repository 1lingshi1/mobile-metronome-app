import MetronomeEngine, { MAX_BPM, MIN_BPM, SUPPORTED_TIME_SIGNATURES } from './metronome-engine.js';
import { loadSoundSettings } from './feature-sound.js';
import { applyStoredBackground } from './feature-background.js';
import { installBackgroundMetronome } from './feature-background-metronome.js';
import { scheduleAtAudibleTime } from './beat-sync.js';

export function initMetronomeUI(options = {}) {
  const documentRef = options.documentRef || document;
  let soundSettings = loadSoundSettings();
  const engine = options.engine || new MetronomeEngine({
    getSoundSettings: () => soundSettings
  });
  const cleanupTasks = [];
  if (!options.disableBackgroundFeature) {
    applyStoredBackground({ documentRef });
  }

  const elements = {
    bpmValue: getRequiredElement(documentRef, 'bpm-value'),
    bpmSlider: getRequiredElement(documentRef, 'bpm-slider'),
    bpmDecrease: getRequiredElement(documentRef, 'bpm-decrease'),
    bpmIncrease: getRequiredElement(documentRef, 'bpm-increase'),
    beatTrack: getRequiredElement(documentRef, 'beat-track'),
    beatCount: getRequiredElement(documentRef, 'beat-count'),
    currentSignature: getRequiredElement(documentRef, 'current-signature'),
    signatureOptions: getRequiredElement(documentRef, 'signature-options'),
    statusText: getRequiredElement(documentRef, 'status-text'),
    resetButton: getRequiredElement(documentRef, 'reset-button'),
    startPauseButton: getRequiredElement(documentRef, 'start-pause-button'),
    startLabel: getRequiredElement(documentRef, 'start-label'),
    backgroundToggle: getRequiredElement(documentRef, 'background-toggle'),
    backgroundToggleLabel: getRequiredElement(documentRef, 'background-toggle-label'),
    backgroundGuide: getRequiredElement(documentRef, 'background-guide'),
    backgroundPermissionStatus: getRequiredElement(documentRef, 'background-permission-status'),
    requestNotificationPermission: getRequiredElement(documentRef, 'request-notification-permission'),
    openBatterySettings: getRequiredElement(documentRef, 'open-battery-settings'),
    closeBackgroundGuide: getRequiredElement(documentRef, 'close-background-guide')
  };

  let beatMarkers = [];
  let activeBeatMarker = null;
  let cancelScheduledBeatFrame = null;
  let renderedSignature = '';
  let startPending = false;
  let backgroundController = null;
  let bpmUpdateTimer = 0;
  let pendingBpm = null;

  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    cleanupTasks.push(() => target.removeEventListener(type, listener, options));
  };

  const logError = (message, error) => {
    if (globalThis.console && typeof globalThis.console.error === 'function') {
      globalThis.console.error(message, error);
    }
  };

  const renderTempo = (state) => {
    elements.bpmValue.textContent = String(state.bpm);
    elements.bpmSlider.value = String(state.bpm);
    elements.bpmSlider.setAttribute('aria-valuetext', `${state.bpm} BPM`);
    const progress = ((state.bpm - MIN_BPM) / (MAX_BPM - MIN_BPM)) * 100;
    elements.bpmSlider.style.setProperty('--slider-progress', `${progress}%`);
  };

  const renderTransport = (state) => {
    elements.startPauseButton.classList.toggle('is-running', state.isRunning);

    if (state.isRunning) {
      elements.startLabel.textContent = '暂停';
      elements.startPauseButton.setAttribute('aria-label', '暂停节拍器');
      elements.statusText.textContent = '进行中';
    } else if (state.status === 'paused') {
      elements.startLabel.textContent = '继续';
      elements.startPauseButton.setAttribute('aria-label', '继续节拍器');
      elements.statusText.textContent = '已暂停';
    } else {
      elements.startLabel.textContent = '开始';
      elements.startPauseButton.setAttribute('aria-label', '开始节拍器');
      elements.statusText.textContent = '准备';
    }

    elements.resetButton.disabled = state.status === 'stopped' && state.beatIndex === 1;
  };

  const activateBeat = (beatIndex, beatsPerBar, accentLevel = 0, animateAccent = false) => {
    const safeBeatIndex = Math.min(Math.max(beatIndex, 1), beatsPerBar);

    const nextMarker = beatMarkers[safeBeatIndex - 1] || null;

    if (activeBeatMarker && activeBeatMarker !== nextMarker) {
      activeBeatMarker.classList.remove('is-active', 'is-pulsing');
    }

    if (nextMarker) {
      nextMarker.classList.remove('is-active', 'is-pulsing');
      nextMarker.classList.add('is-active');
      if (animateAccent && accentLevel > 0) {
        // Restart the pulse in the same frame as the audio beat. Deferring this
        // to another animation frame made the visible hit lag by 1-2 frames.
        void nextMarker.offsetWidth;
        nextMarker.classList.add('is-pulsing');
      }
    }

    activeBeatMarker = nextMarker;

    elements.beatCount.textContent = `第 ${safeBeatIndex} / ${beatsPerBar} 拍`;
  };

  const cancelScheduledBeat = () => {
    if (cancelScheduledBeatFrame) {
      cancelScheduledBeatFrame();
      cancelScheduledBeatFrame = null;
    }
  };

  const renderBeat = (payload) => {
    cancelScheduledBeat();
    cancelScheduledBeatFrame = scheduleAtAudibleTime(payload.audibleAtEpochMs, () => {
      cancelScheduledBeatFrame = null;
      activateBeat(
        payload.beatIndex,
        payload.beatsPerBar,
        payload.accentLevel,
        payload.isAccent
      );
    });
  };

  const renderBackgroundToggle = () => {
    const available = Boolean(backgroundController && backgroundController.available);
    elements.backgroundToggle.classList.toggle('is-enabled', available);
    elements.backgroundToggle.setAttribute('aria-pressed', String(available));
    elements.backgroundToggle.setAttribute('aria-label', '打开后台运行设置');
    elements.backgroundToggleLabel.textContent = '后台';
  };

  const refreshBackgroundGuideStatus = async () => {
    if (!backgroundController) {
      return;
    }
    const [notification, battery] = await Promise.all([
      backgroundController.checkNotificationPermission(),
      backgroundController.isIgnoringBatteryOptimizations()
    ]);
    if (notification.unavailable) {
      elements.backgroundPermissionStatus.textContent = '原生节拍服务仅在 Android App 中可用。';
      return;
    }
    const notificationText = notification.granted ? '通知权限已允许。' : '请允许通知，以显示后台节拍控制。';
    const batteryText = battery.ignoring ? '已允许后台活动。' : '建议在电池设置中允许后台活动。';
    elements.backgroundPermissionStatus.textContent = `${notificationText}${batteryText}`;
  };

  const rebuildBeatTrack = (state, activeBeat = 1) => {
    const beatsPerBar = state.beatsPerBar;
    const denominator = state.timeSignature.denominator;
    const useCompactLayout = denominator === 8 || beatsPerBar > 8;
    const layout = useCompactLayout ? 'compact' : (beatsPerBar <= 4 ? 'single' : 'double');

    elements.beatTrack.dataset.layout = layout;
    elements.beatTrack.dataset.rows = String(Math.ceil(beatsPerBar / (useCompactLayout ? 6 : 4)));
    elements.beatTrack.replaceChildren();
    beatMarkers = [];
    activeBeatMarker = null;
    cancelScheduledBeat();

    for (let beatIndex = 1; beatIndex <= beatsPerBar; beatIndex += 1) {
      const accentLevel = state.accentPattern[beatIndex - 1] || 0;
      const markerType = accentLevel === 2 ? 'strong' : (accentLevel === 1 ? 'secondary' : 'regular');
      const marker = documentRef.createElement('div');
      marker.className = `beat-marker beat-marker--${markerType}`;
      marker.dataset.beatIndex = String(beatIndex);
      marker.dataset.accentLevel = String(accentLevel);
      elements.beatTrack.appendChild(marker);
      beatMarkers.push(marker);
    }

    activateBeat(activeBeat, beatsPerBar, state.accentPattern[activeBeat - 1] || 0);
  };

  const renderSignature = (state) => {
    const currentSignature = state.timeSignature;
    elements.currentSignature.textContent = state.timeSignatureLabel;
    elements.signatureOptions.replaceChildren();

    SUPPORTED_TIME_SIGNATURES
      .filter((signature) => (
        signature.numerator !== currentSignature.numerator ||
        signature.denominator !== currentSignature.denominator
      ))
      .forEach((signature) => {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = 'signature-option';
        button.dataset.numerator = String(signature.numerator);
        button.dataset.denominator = String(signature.denominator);
        button.textContent = `${signature.numerator}/${signature.denominator}`;
        button.setAttribute('aria-label', `切换到 ${signature.numerator}/${signature.denominator} 拍`);
        elements.signatureOptions.appendChild(button);
      });
  };

  const renderState = (state, options = {}) => {
    if (!state.isRunning) {
      cancelScheduledBeat();
    }
    const shouldSyncBeat = options.syncBeat === true || !state.isRunning;
    const nextSignature = state.timeSignatureLabel;
    renderTempo(state);
    if (nextSignature !== renderedSignature) {
      renderedSignature = nextSignature;
      renderSignature(state);
      rebuildBeatTrack(state, state.beatIndex);
    } else if (shouldSyncBeat) {
      activateBeat(
        state.beatIndex,
        state.beatsPerBar,
        state.accentPattern[state.beatIndex - 1] || 0
      );
    }
    renderTransport(state);
  };

  const applyBpm = (value) => {
    pendingBpm = value;
    commitBpm();
  };

  const commitBpm = () => {
    if (bpmUpdateTimer) {
      clearTimeout(bpmUpdateTimer);
      bpmUpdateTimer = 0;
    }
    if (pendingBpm === null) {
      return;
    }
    const value = pendingBpm;
    pendingBpm = null;
    renderTempo(engine.setBpm(value));
  };

  const previewBpm = (value) => {
    pendingBpm = value;
    renderTempo({ bpm: Number(value) });
    if (!bpmUpdateTimer) {
      bpmUpdateTimer = setTimeout(commitBpm, 80);
    }
  };

  const applyTimeSignature = (numerator, denominator) => {
    renderState(engine.setTimeSignature(numerator, denominator));
  };

  listen(elements.bpmSlider, 'input', () => {
    previewBpm(elements.bpmSlider.value);
  });

  listen(elements.bpmSlider, 'change', commitBpm);

  listen(elements.bpmDecrease, 'click', () => {
    applyBpm(engine.getState().bpm - 1);
  });

  listen(elements.bpmIncrease, 'click', () => {
    applyBpm(engine.getState().bpm + 1);
  });

  listen(elements.signatureOptions, 'click', (event) => {
    const button = event.target.closest('.signature-option');
    if (!button) {
      return;
    }
    applyTimeSignature(Number(button.dataset.numerator), Number(button.dataset.denominator));
  });

  listen(elements.startPauseButton, 'click', async () => {
    commitBpm();
    const state = engine.getState();

    if (state.isRunning) {
      try {
        renderState(await engine.pause('pause'));
      } catch (error) {
        elements.statusText.textContent = '暂停失败，请重试';
        logError('无法暂停原生节拍服务。', error);
      }
      return;
    }

    if (startPending) {
      return;
    }

    startPending = true;
    elements.startPauseButton.setAttribute('aria-busy', 'true');

    try {
      soundSettings = loadSoundSettings();
      renderState(await engine.start());
    } catch (error) {
      elements.statusText.textContent = '原生节拍启动失败，请重试';
      logError('无法启动原生节拍服务。', error);
    } finally {
      startPending = false;
      elements.startPauseButton.removeAttribute('aria-busy');
    }
  });

  listen(elements.resetButton, 'click', async () => {
    try {
      renderState(await engine.reset());
    } catch (error) {
      elements.statusText.textContent = '重置失败，请重试';
      logError('无法重置原生节拍服务。', error);
    }
  });

  listen(elements.backgroundToggle, 'click', async () => {
    elements.backgroundGuide.hidden = false;
    await refreshBackgroundGuideStatus();
  });

  listen(elements.requestNotificationPermission, 'click', async () => {
    if (!backgroundController) {
      return;
    }
    await backgroundController.requestNotificationPermission();
    await refreshBackgroundGuideStatus();
  });

  listen(elements.openBatterySettings, 'click', async () => {
    if (!backgroundController) {
      return;
    }
    await backgroundController.openBatterySettings();
    await refreshBackgroundGuideStatus();
  });

  listen(elements.closeBackgroundGuide, 'click', () => {
    elements.backgroundGuide.hidden = true;
  });

  listen(documentRef, 'visibilitychange', () => {
    if (!documentRef.hidden) {
      soundSettings = loadSoundSettings();
      engine.syncState()
        .then((state) => renderState(state, { syncBeat: true }))
        .catch((error) => logError('无法同步原生节拍状态。', error));
    }
  });

  const unsubscribeBeat = engine.onBeat((payload) => {
    renderBeat(payload);
  });
  cleanupTasks.push(unsubscribeBeat);

  const unsubscribeStop = engine.onStop((payload) => {
    renderState(payload.state);
  });
  cleanupTasks.push(unsubscribeStop);

  const unsubscribeReset = engine.onReset((payload) => {
    renderState(payload.state);
  });
  cleanupTasks.push(unsubscribeReset);

  const unsubscribeState = engine.onState((state) => {
    renderState(state);
  });
  cleanupTasks.push(unsubscribeState);

  backgroundController = installBackgroundMetronome();
  renderBackgroundToggle();
  renderState(engine.getState());

  engine.initialize()
    .then((state) => renderState(state, { syncBeat: true }))
    .catch((error) => {
      elements.statusText.textContent = '原生节拍服务不可用';
      logError('无法初始化原生节拍服务。', error);
    });

  return {
    engine,
    destroy() {
      commitBpm();
      cancelScheduledBeat();
      if (backgroundController) {
        cleanupTasks.push(() => backgroundController.destroy());
      }
      cleanupTasks.splice(0).forEach((cleanup) => cleanup());
      engine.destroy();
    }
  };
}

function getRequiredElement(documentRef, id) {
  const element = documentRef.getElementById(id);
  if (!element) {
    throw new Error(`缺少 UI 元素：#${id}`);
  }
  return element;
}

if (typeof document !== 'undefined') {
  globalThis.metronomeApp = initMetronomeUI();
}

export default initMetronomeUI;
