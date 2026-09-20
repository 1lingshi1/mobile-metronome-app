const TONE_SELECTION_STORAGE_KEY = 'metronome-tone-selection-v1';
const DEFAULT_TONE_ID = 'mechanical';

export const TONE_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'mechanical',
    name: '机械节拍',
    description: '重拍叮，普通拍滴，6/8 第4拍特殊拍',
    implemented: true
  }),
  Object.freeze({
    id: 'drum-machine',
    name: '鼓机',
    description: '鼓组音色',
    implemented: true
  })
]);

export function getToneById(toneId) {
  return TONE_OPTIONS.find((tone) => tone.id === toneId) || null;
}

export function loadSelectedTone(storage = globalThis.localStorage) {
  if (!storage) {
    return DEFAULT_TONE_ID;
  }

  try {
    const stored = storage.getItem(TONE_SELECTION_STORAGE_KEY);
    return getToneById(stored) ? stored : DEFAULT_TONE_ID;
  } catch (error) {
    return DEFAULT_TONE_ID;
  }
}

export function saveSelectedTone(toneId, storage = globalThis.localStorage) {
  const tone = getToneById(toneId);
  if (!tone) {
    throw new Error('请选择有效的节拍器音色。');
  }

  if (storage) {
    try {
      storage.setItem(TONE_SELECTION_STORAGE_KEY, tone.id);
    } catch (error) {
      // The selection remains active for the current page when storage is unavailable.
    }
  }
  return tone.id;
}

export function installToneSelector(options = {}) {
  const documentRef = options.documentRef || document;
  const storage = options.storage || globalThis.localStorage;
  const onChange = options.onChange || (() => {});

  const elements = {
    openButton: getElement(documentRef, 'open-tone-selector'),
    selectedName: getElement(documentRef, 'selected-tone-name'),
    selectedDescription: getElement(documentRef, 'selected-tone-description'),
    status: getElement(documentRef, 'tone-selection-status'),
    backdrop: getElement(documentRef, 'tone-selector-backdrop'),
    pickerDialog: getElement(documentRef, 'tone-picker-dialog'),
    confirmationDialog: getElement(documentRef, 'tone-confirm-dialog'),
    currentName: getElement(documentRef, 'tone-current-name'),
    optionsList: getElement(documentRef, 'tone-options'),
    closeButton: getElement(documentRef, 'close-tone-selector'),
    confirmationMessage: getElement(documentRef, 'tone-confirm-message'),
    cancelButton: getElement(documentRef, 'cancel-tone-change'),
    confirmButton: getElement(documentRef, 'confirm-tone-change')
  };

  let currentToneId = loadSelectedTone(storage);
  let pendingToneId = null;
  const cleanups = [];

  const listen = (target, type, listener) => {
    target.addEventListener(type, listener);
    cleanups.push(() => target.removeEventListener(type, listener));
  };

  const renderCurrentTone = () => {
    const currentTone = getToneById(currentToneId) || getToneById(DEFAULT_TONE_ID);
    elements.selectedName.textContent = currentTone.name;
    elements.selectedDescription.textContent = currentTone.description;
  };

  const renderOptions = () => {
    elements.optionsList.replaceChildren();

    TONE_OPTIONS.forEach((tone) => {
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'tone-option';
      button.dataset.toneId = tone.id;
      button.setAttribute('aria-pressed', tone.id === currentToneId ? 'true' : 'false');
      button.classList.toggle('is-current', tone.id === currentToneId);

      const name = documentRef.createElement('span');
      name.className = 'tone-option__name';
      name.textContent = tone.name;

      const description = documentRef.createElement('span');
      description.className = 'tone-option__description';
      description.textContent = tone.description;

      const state = documentRef.createElement('span');
      state.className = 'tone-option__state';
      state.textContent = tone.id === currentToneId ? '当前' : (tone.implemented ? '可选择' : '待接入');

      button.appendChild(name);
      button.appendChild(description);
      button.appendChild(state);
      elements.optionsList.appendChild(button);
    });
  };

  const closeSelector = () => {
    elements.backdrop.hidden = true;
    elements.pickerDialog.hidden = false;
    elements.confirmationDialog.hidden = true;
    pendingToneId = null;
    elements.openButton.setAttribute('aria-expanded', 'false');
  };

  const openSelector = () => {
    pendingToneId = null;
    elements.currentName.textContent = (getToneById(currentToneId) || getToneById(DEFAULT_TONE_ID)).name;
    renderOptions();
    elements.backdrop.hidden = false;
    elements.pickerDialog.hidden = false;
    elements.confirmationDialog.hidden = true;
    elements.openButton.setAttribute('aria-expanded', 'true');
  };

  const showConfirmation = (toneId) => {
    const nextTone = getToneById(toneId);
    if (!nextTone) {
      return;
    }

    pendingToneId = nextTone.id;
    const currentTone = getToneById(currentToneId) || getToneById(DEFAULT_TONE_ID);
    elements.pickerDialog.hidden = true;
    elements.confirmationDialog.hidden = false;

    if (nextTone.id === currentTone.id) {
      elements.confirmationMessage.textContent = `当前音色已经是「${currentTone.name}」。`;
      elements.confirmButton.disabled = true;
      return;
    }

    elements.confirmButton.disabled = false;
    elements.confirmationMessage.textContent = nextTone.implemented
      ? `确认将节拍器音色从「${currentTone.name}」更换为「${nextTone.name}」吗？`
      : `确认将当前音色改为「${nextTone.name}」吗？该音色的具体波形将在后续版本接入。`;
  };

  const cancelConfirmation = () => {
    pendingToneId = null;
    elements.confirmationDialog.hidden = true;
    elements.pickerDialog.hidden = false;
  };

  const confirmSelection = () => {
    const nextTone = getToneById(pendingToneId);
    if (!nextTone || nextTone.id === currentToneId) {
      return;
    }

    currentToneId = saveSelectedTone(nextTone.id, storage);
    renderCurrentTone();
    const statusText = nextTone.implemented
      ? `已更换为「${nextTone.name}」。`
      : `已选择「${nextTone.name}」；具体波形将在后续版本接入。`;
    elements.status.textContent = statusText;
    onChange(getToneById(currentToneId), statusText);
    closeSelector();
  };

  listen(elements.openButton, 'click', openSelector);
  listen(elements.closeButton, 'click', closeSelector);
  listen(elements.cancelButton, 'click', cancelConfirmation);
  listen(elements.confirmButton, 'click', confirmSelection);
  listen(elements.optionsList, 'click', (event) => {
    const button = event.target.closest('.tone-option');
    if (button) {
      showConfirmation(button.dataset.toneId);
    }
  });
  listen(elements.backdrop, 'click', (event) => {
    if (event.target === elements.backdrop) {
      closeSelector();
    }
  });

  renderCurrentTone();

  return {
    getCurrentTone() {
      return getToneById(currentToneId);
    },
    open: openSelector,
    close: closeSelector,
    destroy() {
      cleanups.splice(0).forEach((cleanup) => cleanup());
    }
  };
}

function getElement(documentRef, id) {
  const element = documentRef.getElementById(id);
  if (!element) {
    throw new Error(`缺少音色选择元素：#${id}`);
  }
  return element;
}

export { DEFAULT_TONE_ID, TONE_SELECTION_STORAGE_KEY };
