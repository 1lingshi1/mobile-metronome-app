export function getBackgroundPlugin() {
  const capacitor = globalThis.Capacitor;
  if (!capacitor || !capacitor.Plugins) {
    return null;
  }
  return capacitor.Plugins.BackgroundMetronome || null;
}

export function installBackgroundMetronome(options = {}) {
  const plugin = options.plugin || getBackgroundPlugin();
  const onError = options.onError || (() => {});

  return {
    get available() {
      return Boolean(plugin);
    },
    async checkNotificationPermission() {
      if (!plugin || typeof plugin.checkNotificationPermission !== 'function') {
        return { granted: false, unavailable: true };
      }
      try {
        return await plugin.checkNotificationPermission();
      } catch (error) {
        onError(error);
        return { granted: false, unavailable: true };
      }
    },
    async requestNotificationPermission() {
      if (!plugin || typeof plugin.requestNotificationPermission !== 'function') {
        return { granted: false, unavailable: true };
      }
      try {
        return await plugin.requestNotificationPermission();
      } catch (error) {
        onError(error);
        return { granted: false, unavailable: true };
      }
    },
    async isIgnoringBatteryOptimizations() {
      if (!plugin || typeof plugin.isIgnoringBatteryOptimizations !== 'function') {
        return { ignoring: false, unavailable: true };
      }
      try {
        return await plugin.isIgnoringBatteryOptimizations();
      } catch (error) {
        onError(error);
        return { ignoring: false, unavailable: true };
      }
    },
    async openBatterySettings() {
      if (!plugin || typeof plugin.openBatterySettings !== 'function') {
        return false;
      }
      try {
        await plugin.openBatterySettings();
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    },
    destroy() {}
  };
}