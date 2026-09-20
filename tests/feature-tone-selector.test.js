import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_TONE_ID,
  TONE_OPTIONS,
  TONE_SELECTION_STORAGE_KEY,
  installToneSelector,
  loadSelectedTone,
  saveSelectedTone
} from '../www/feature-tone-selector.js';

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

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    if (force === true) {
      this.values.add(name);
      return true;
    }
    if (force === false) {
      this.values.delete(name);
      return false;
    }
    if (this.values.has(name)) {
      this.values.delete(name);
      return false;
    }
    this.values.add(name);
    return true;
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.type = '';
    this.className = '';
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  emit(type, event = {}) {
    const listener = this.listeners.get(type);
    if (listener) {
      listener({ target: this, ...event });
    }
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  closest(selector) {
    const isToneOption = this.className.includes('tone-option') || this.classList.contains('tone-option');
    return selector.includes('tone-option') && isToneOption ? this : null;
  }
}

function createDocument(ids) {
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  return {
    elements,
    createElement() {
      return new FakeElement('');
    },
    getElementById(id) {
      return elements.get(id) || null;
    }
  };
}

const SELECTOR_IDS = [
  'open-tone-selector',
  'selected-tone-name',
  'selected-tone-description',
  'tone-selection-status',
  'tone-selector-backdrop',
  'tone-picker-dialog',
  'tone-confirm-dialog',
  'tone-current-name',
  'tone-options',
  'close-tone-selector',
  'tone-confirm-message',
  'cancel-tone-change',
  'confirm-tone-change'
];

test('native service and plugin default to the mechanical tone', async () => {
  const [serviceSource, pluginSource] = await Promise.all([
    readFile(new URL('../android/app/src/main/java/com/mobilemetronome/app/BackgroundMetronomeService.java', import.meta.url), 'utf8'),
    readFile(new URL('../android/app/src/main/java/com/mobilemetronome/app/BackgroundMetronomePlugin.java', import.meta.url), 'utf8')
  ]);

  assert.match(serviceSource, /private volatile String toneId = TONE_MECHANICAL/);
  assert.match(serviceSource, /getString\("toneId", TONE_MECHANICAL\)/);
  assert.match(pluginSource, /private volatile String toneId = BackgroundMetronomeService\.TONE_MECHANICAL/);
});

test('the catalog defaults to mechanical and keeps drum machine selectable', () => {
  assert.deepEqual(TONE_OPTIONS.map((tone) => tone.id), [DEFAULT_TONE_ID, 'drum-machine']);
  assert.deepEqual(TONE_OPTIONS.map((tone) => tone.name), ['机械节拍', '鼓机']);
  assert.equal(TONE_OPTIONS[1].description, '鼓组音色');
});

test('default mechanical selection persists while removed tone IDs fall back', () => {
  const storage = createStorage();
  assert.equal(loadSelectedTone(storage), DEFAULT_TONE_ID);
  assert.equal(saveSelectedTone('drum-machine', storage), 'drum-machine');
  assert.equal(loadSelectedTone(storage), 'drum-machine');
  assert.throws(() => saveSelectedTone('wooden-hit', storage), /有效的节拍器音色/);

  storage.setItem(TONE_SELECTION_STORAGE_KEY, 'crisp-click');
  assert.equal(loadSelectedTone(storage), DEFAULT_TONE_ID);
});

test('selecting drum machine requires confirmation and saves the tone', () => {
  const storage = createStorage();
  const documentRef = createDocument(SELECTOR_IDS);
  const elements = documentRef.elements;
  let changedTone = null;
  const controller = installToneSelector({
    documentRef,
    storage,
    onChange(tone) {
      changedTone = tone;
    }
  });

  elements.get('open-tone-selector').emit('click');
  assert.equal(elements.get('tone-options').children.length, 2);
  const drumMachineButton = elements.get('tone-options').children.find(
    (button) => button.dataset.toneId === 'drum-machine'
  );
  elements.get('tone-options').emit('click', { target: drumMachineButton });

  assert.equal(elements.get('tone-confirm-dialog').hidden, false);
  assert.equal(elements.get('confirm-tone-change').disabled, false);
  assert.match(elements.get('tone-confirm-message').textContent, /鼓机/);
  elements.get('confirm-tone-change').emit('click');

  assert.equal(loadSelectedTone(storage), 'drum-machine');
  assert.equal(elements.get('selected-tone-name').textContent, '鼓机');
  assert.equal(changedTone.id, 'drum-machine');
  assert.equal(elements.get('tone-selector-backdrop').hidden, true);
  controller.destroy();
});
