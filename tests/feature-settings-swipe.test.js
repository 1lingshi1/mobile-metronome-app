import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installSettingsSwipe } from '../www/feature-settings-swipe.js';

class FakeDocument {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  emit(type, event) {
    const listener = this.listeners.get(type);
    if (listener) {
      listener(event);
    }
  }
}

function swipe(documentRef, locationRef, start, end, target = null) {
  documentRef.emit('touchstart', {
    touches: [{ clientX: start.x, clientY: start.y, target }]
  });
  documentRef.emit('touchend', {
    changedTouches: [{ clientX: end.x, clientY: end.y }]
  });
}

test('slider gesture guards do not trigger settings navigation', () => {
  const documentRef = new FakeDocument();
  const locationRef = { assigned: null, assign(target) { this.assigned = target; } };
  installSettingsSwipe({ direction: 'left', target: './more-settings.html', documentRef, location: locationRef });
  const sliderGuard = {
    closest(selector) {
      return selector.includes('[data-settings-no-swipe]') ? this : null;
    }
  };

  swipe(documentRef, locationRef, { x: 240, y: 120 }, { x: 100, y: 120 }, sliderGuard);
  assert.equal(locationRef.assigned, null);
});

test('left swipe navigates to the next settings page', () => {
  const documentRef = new FakeDocument();
  const locationRef = { assigned: null, assign(target) { this.assigned = target; } };
  installSettingsSwipe({ direction: 'left', target: './more-settings.html', documentRef, location: locationRef });

  swipe(documentRef, locationRef, { x: 240, y: 120 }, { x: 120, y: 126 });
  assert.equal(locationRef.assigned, './more-settings.html');
});

test('right swipe navigates back to the previous settings page', () => {
  const documentRef = new FakeDocument();
  const locationRef = { assigned: null, assign(target) { this.assigned = target; } };
  installSettingsSwipe({ direction: 'right', target: './sound-settings.html', documentRef, location: locationRef });

  swipe(documentRef, locationRef, { x: 100, y: 120 }, { x: 230, y: 124 });
  assert.equal(locationRef.assigned, './sound-settings.html');
});

test('slider touches and vertical scrolling do not trigger navigation', () => {
  const documentRef = new FakeDocument();
  const locationRef = { assigned: null, assign(target) { this.assigned = target; } };
  installSettingsSwipe({ direction: 'left', target: './more-settings.html', documentRef, location: locationRef });
  const slider = { closest(selector) { return selector.includes('input') ? this : null; } };

  swipe(documentRef, locationRef, { x: 240, y: 120 }, { x: 100, y: 120 }, slider);
  swipe(documentRef, locationRef, { x: 240, y: 100 }, { x: 120, y: 180 });
  assert.equal(locationRef.assigned, null);
});
test('every slider setting row opts out of settings-page swipes', () => {
  const html = readFileSync(new URL('../www/sound-settings.html', import.meta.url), 'utf8');
  const protectedRows = html.match(/<label class="setting-control"[^>]*data-settings-no-swipe/g) || [];
  assert.equal(protectedRows.length, 5);
});
