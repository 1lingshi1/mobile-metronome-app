import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackgroundMetronome } from '../www/feature-background-metronome.js';

test('background settings controller exposes native permission status', async () => {
  const controller = installBackgroundMetronome({
    plugin: {
      async checkNotificationPermission() {
        return { granted: true };
      },
      async isIgnoringBatteryOptimizations() {
        return { ignoring: false };
      }
    }
  });

  assert.equal(controller.available, true);
  assert.deepEqual(await controller.checkNotificationPermission(), { granted: true });
  assert.deepEqual(await controller.isIgnoringBatteryOptimizations(), { ignoring: false });
});

test('background settings controller is unavailable outside Capacitor', async () => {
  const controller = installBackgroundMetronome({ plugin: null });
  assert.equal(controller.available, false);
  assert.deepEqual(await controller.checkNotificationPermission(), {
    granted: false,
    unavailable: true
  });
  assert.deepEqual(await controller.isIgnoringBatteryOptimizations(), {
    ignoring: false,
    unavailable: true
  });
});

test('background settings controller never pauses or restarts the engine', () => {
  const controller = installBackgroundMetronome({ plugin: null });
  assert.equal('setEnabled' in controller, false);
  assert.equal('nativeActive' in controller, false);
  assert.equal(typeof controller.destroy, 'function');
  controller.destroy();
});