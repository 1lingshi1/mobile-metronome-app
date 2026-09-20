import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySliderGesture,
  getSliderValueFromPointer,
  installSafeSlider
} from '../www/feature-safe-slider.js';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = '';
    this.value = '0';
    this.min = '0';
    this.max = '1';
    this.step = '0.1';
    this.rect = { left: 0, width: 100 };
    this.rectReadCount = 0;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  dispatchEvent(event) {
    const listener = this.listeners.get(event.type);
    if (listener) {
      listener(event);
    }
    return true;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  setPointerCapture(pointerId) {
    this.capturedPointerId = pointerId;
  }

  getBoundingClientRect() {
    this.rectReadCount += 1;
    return this.rect;
  }

  remove() {
    if (!this.parentNode) {
      return;
    }
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) {
      this.parentNode.children.splice(index, 1);
    }
    this.parentNode = null;
  }
}

function createSlider() {
  const documentRef = {
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };
  const parent = new FakeElement('label');
  const slider = new FakeElement('input');
  slider.ownerDocument = documentRef;
  slider.min = '0.5';
  slider.max = '1.5';
  slider.step = '0.05';
  slider.value = '1';
  slider.rect = { left: 0, width: 200 };
  parent.appendChild(slider);
  const cleanup = installSafeSlider(slider, { documentRef });
  return { cleanup, guard: parent.children[0].children[1], parent, slider };
}

function pointerEvent(type, pointerId, clientX, clientY) {
  return { type, pointerId, clientX, clientY, cancelable: true, preventDefault() {} };
}

test('slider gesture classification separates vertical scrolling from horizontal adjustment', () => {
  assert.equal(classifySliderGesture(3, 14), 'scroll');
  assert.equal(classifySliderGesture(14, 3), 'adjust');
  assert.equal(classifySliderGesture(4, 3), 'pending');
});

test('slider value calculation follows the range and step', () => {
  assert.equal(getSliderValueFromPointer({
    clientX: 0,
    rect: { left: 0, width: 100 },
    minimum: 0.5,
    maximum: 1.5,
    step: 0.05,
    thumbSize: 0
  }), 0.5);
  assert.equal(getSliderValueFromPointer({
    clientX: 50,
    rect: { left: 0, width: 100 },
    minimum: 0.5,
    maximum: 1.5,
    step: 0.05,
    thumbSize: 0
  }), 1);
  assert.equal(getSliderValueFromPointer({
    clientX: 100,
    rect: { left: 0, width: 100 },
    minimum: 0.5,
    maximum: 1.5,
    step: 0.05,
    thumbSize: 0
  }), 1.5);
});

test('slider guard is excluded from horizontal settings-page navigation', () => {
  const { guard } = createSlider();
  assert.equal(guard.attributes.has('data-settings-no-swipe'), true);
});

test('vertical slider gestures leave the settings value unchanged', () => {
  const { guard, slider } = createSlider();
  let inputEvents = 0;
  slider.addEventListener('input', () => { inputEvents += 1; });

  const handleDown = guard.listeners.get('pointerdown');
  const handleMove = guard.listeners.get('pointermove');
  handleDown(pointerEvent('pointerdown', 1, 100, 100));
  handleMove(pointerEvent('pointermove', 1, 103, 114));

  assert.equal(inputEvents, 0);
  assert.equal(slider.value, '1');
});

test('horizontal slider gestures adjust the value while taps do not', () => {
  const { guard, slider } = createSlider();
  let inputEvents = 0;
  slider.addEventListener('input', () => { inputEvents += 1; });

  const handleDown = guard.listeners.get('pointerdown');
  const handleMove = guard.listeners.get('pointermove');
  const handleUp = guard.listeners.get('pointerup');

  handleDown(pointerEvent('pointerdown', 2, 100, 100));
  handleUp(pointerEvent('pointerup', 2, 100, 100));
  assert.equal(inputEvents, 0);

  handleDown(pointerEvent('pointerdown', 3, 100, 100));
  handleMove(pointerEvent('pointermove', 3, 130, 102));
  assert.equal(inputEvents, 1);
  assert.ok(Number(slider.value) > 1);
});

test('a slider gesture caches its rect and emits change only when it adjusted', () => {
  const { guard, slider } = createSlider();
  let inputEvents = 0;
  let changeEvents = 0;
  slider.addEventListener('input', () => { inputEvents += 1; });
  slider.addEventListener('change', () => { changeEvents += 1; });

  const handleDown = guard.listeners.get('pointerdown');
  const handleMove = guard.listeners.get('pointermove');
  const handleUp = guard.listeners.get('pointerup');
  const readsBeforeGesture = slider.rectReadCount;

  handleDown(pointerEvent('pointerdown', 4, 100, 100));
  handleMove(pointerEvent('pointermove', 4, 120, 101));
  handleMove(pointerEvent('pointermove', 4, 140, 102));
  handleUp(pointerEvent('pointerup', 4, 140, 102));

  assert.equal(slider.rectReadCount - readsBeforeGesture, 1);
  assert.equal(inputEvents, 2);
  assert.equal(changeEvents, 1);
});
