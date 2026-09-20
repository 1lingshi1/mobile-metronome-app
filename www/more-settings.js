import {
  applyBackgroundImage,
  applyStoredBackground,
  loadBackgroundImage,
  processBackgroundFile,
  removeBackgroundImage,
  saveBackgroundImage
} from './feature-background.js';
import { installSettingsSwipe } from './feature-settings-swipe.js';
import { installToneSelector } from './feature-tone-selector.js';

applyStoredBackground();
const toneSelector = installToneSelector({
  onChange: syncToneToNative
});
syncToneToNative(toneSelector.getCurrentTone());

function syncToneToNative(tone) {
  const plugin = globalThis.Capacitor && globalThis.Capacitor.Plugins
    ? globalThis.Capacitor.Plugins.BackgroundMetronome
    : null;
  if (!tone || !plugin || typeof plugin.setTone !== 'function') {
    return Promise.resolve(false);
  }

  return plugin.setTone({ toneId: tone.id }).catch((error) => {
    if (globalThis.console && typeof globalThis.console.error === 'function') {
      globalThis.console.error('同步节拍器音色失败。', error);
    }
    return false;
  });
}

const elements = {
  preview: getElement('background-preview'),
  fileInput: getElement('background-file-input'),
  selectButton: getElement('select-background'),
  removeButton: getElement('remove-background'),
  status: getElement('background-status')
};

let busy = false;

function getElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`缺少背景设置元素：#${id}`);
  }
  return element;
}

function renderBackground(dataUrl, message = '') {
  const hasImage = Boolean(dataUrl);
  elements.preview.classList.toggle('has-image', hasImage);
  elements.preview.style.backgroundImage = hasImage ? `url("${dataUrl}")` : '';
  elements.preview.setAttribute('aria-label', hasImage ? '已设置自定义背景图片' : '尚未设置背景图片');
  elements.removeButton.disabled = !hasImage;
  elements.status.textContent = message || (hasImage ? '背景图片已保存，返回主页后生效。' : '当前使用默认背景。');
}

function setBusy(nextBusy) {
  busy = nextBusy;
  elements.selectButton.disabled = nextBusy;
  elements.removeButton.disabled = nextBusy || !loadBackgroundImage();
  elements.selectButton.textContent = nextBusy ? '处理中…' : '选择图片';
}

elements.selectButton.addEventListener('click', () => {
  if (busy) {
    return;
  }
  elements.fileInput.value = '';
  elements.fileInput.click();
});

elements.fileInput.addEventListener('change', async () => {
  const file = elements.fileInput.files && elements.fileInput.files[0];
  if (!file || busy) {
    return;
  }

  setBusy(true);
  elements.status.textContent = '正在压缩图片…';

  try {
    const dataUrl = await processBackgroundFile(file);
    saveBackgroundImage(dataUrl);
    applyBackgroundImage(dataUrl);
    renderBackground(dataUrl, '背景图片已保存并应用到所有页面。');
  } catch (error) {
    elements.status.textContent = error.message || '背景图片处理失败。';
  } finally {
    setBusy(false);
    elements.fileInput.value = '';
  }
});

elements.removeButton.addEventListener('click', () => {
  if (busy) {
    return;
  }
  removeBackgroundImage();
  applyBackgroundImage(null);
  renderBackground(null, '背景图片已移除。');
});

renderBackground(loadBackgroundImage());

installSettingsSwipe({
  direction: 'right',
  target: './sound-settings.html'
});