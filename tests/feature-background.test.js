import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBackgroundImage,
  loadBackgroundImage,
  removeBackgroundImage,
  saveBackgroundImage
} from '../www/feature-background.js';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('background images can be saved, loaded, and removed', () => {
  const storage = createStorage();
  const image = 'data:image/jpeg;base64,AAAA';

  assert.equal(loadBackgroundImage(storage), null);
  saveBackgroundImage(image, storage);
  assert.equal(loadBackgroundImage(storage), image);
  removeBackgroundImage(storage);
  assert.equal(loadBackgroundImage(storage), null);
});

test('invalid background data is rejected', () => {
  assert.throws(() => saveBackgroundImage('not-an-image', createStorage()), /背景图片数据无效/);
});

test('applying and clearing a background toggles the document state', () => {
  const classes = new Set();
  const properties = new Map();
  const documentRef = {
    documentElement: {
      style: {
        setProperty(name, value) {
          properties.set(name, value);
        },
        removeProperty(name) {
          properties.delete(name);
        }
      }
    },
    body: {
      classList: {
        add(name) {
          classes.add(name);
        },
        remove(name) {
          classes.delete(name);
        }
      }
    }
  };
  const image = 'data:image/jpeg;base64,AAAA';

  applyBackgroundImage(image, documentRef);
  assert.equal(classes.has('has-custom-background'), true);
  assert.equal(properties.has('--custom-background-image'), true);

  applyBackgroundImage(null, documentRef);
  assert.equal(classes.has('has-custom-background'), false);
  assert.equal(properties.has('--custom-background-image'), false);
});