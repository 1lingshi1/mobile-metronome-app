package com.mobilemetronome.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "BackgroundMetronome",
    permissions = {
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class BackgroundMetronomePlugin extends Plugin {

    private volatile int bpm = 120;
    private volatile int beatsPerBar = 4;
    private volatile int denominator = 4;
    private volatile String toneId = BackgroundMetronomeService.TONE_MECHANICAL;
    private volatile int beatIndex = 1;
    private volatile int nextBeatIndex = 2;
    private volatile int[] accentPattern = new int[] { 2, 0, 0, 0 };
    private volatile float volume = 5.0f;
    private volatile float brightness = 1.0f;
    private volatile float kick = 1.5f;
    private volatile float snare = 1.5f;
    private volatile float hat = 1.0f;
    private volatile boolean running = false;
    private volatile boolean appVisible = true;
    private BackgroundMetronomeService.EventListener serviceListener;

    @Override
    public void load() {
        BackgroundMetronomeService.Snapshot currentSnapshot = BackgroundMetronomeService.getSnapshot();
        syncConfiguration(currentSnapshot);
        if (currentSnapshot == null || !currentSnapshot.running) {
            toneId = BackgroundMetronomeService.loadToneId(getContext());
        }
        serviceListener = new BackgroundMetronomeService.EventListener() {
            @Override
            public void onBeat(
                int beatIndex,
                int beatsPerBar,
                int denominator,
                int accentLevel,
                long framePosition,
                long audibleAtEpochMs
            ) {
                if (!appVisible) {
                    return;
                }
                BackgroundMetronomePlugin.this.beatIndex = beatIndex;
                BackgroundMetronomePlugin.this.beatsPerBar = beatsPerBar;
                BackgroundMetronomePlugin.this.denominator = denominator;
                BackgroundMetronomePlugin.this.nextBeatIndex = advanceBeatIndex(beatIndex, beatsPerBar);
                BackgroundMetronomePlugin.this.running = true;

                JSObject payload = new JSObject();
                payload.put("beatIndex", beatIndex);
                payload.put("beatsPerBar", beatsPerBar);
                payload.put("denominator", denominator);
                payload.put("accentLevel", accentLevel);
                payload.put("accentPattern", joinPattern(BackgroundMetronomePlugin.this.accentPattern));
                payload.put("framePosition", framePosition);
                payload.put("audibleAtEpochMs", audibleAtEpochMs);
                notifyOnMainThread("beat", payload);
            }

            @Override
            public void onStateChanged(BackgroundMetronomeService.Snapshot snapshot) {
                if (!appVisible) {
                    syncConfiguration(snapshot);
                    return;
                }
                syncConfiguration(snapshot);
                notifyOnMainThread("state", toJSObject(snapshot));
            }

            @Override
            public void onPreviewBeat(
                int beatIndex,
                int beatsPerBar,
                int accentLevel,
                long framePosition,
                long audibleAtEpochMs
            ) {
                if (!appVisible) {
                    return;
                }
                JSObject payload = new JSObject();
                payload.put("beatIndex", beatIndex);
                payload.put("beatsPerBar", beatsPerBar);
                payload.put("accentLevel", accentLevel);
                payload.put("framePosition", framePosition);
                payload.put("audibleAtEpochMs", audibleAtEpochMs);
                notifyOnMainThread("previewBeat", payload);
            }

            @Override
            public void onPreviewFinished() {
                if (!appVisible) {
                    return;
                }
                JSObject payload = new JSObject();
                payload.put("completed", true);
                notifyOnMainThread("previewFinished", payload);
            }
        };
        BackgroundMetronomeService.setEventListener(serviceListener);
    }

    @Override
    protected void handleOnResume() {
        appVisible = true;
        super.handleOnResume();
    }

    @Override
    protected void handleOnPause() {
        appVisible = false;
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        BackgroundMetronomeService.setEventListener(null);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        try {
            readConfiguration(call, true);
            running = true;
            Intent intent = createConfigurationIntent(call, BackgroundMetronomeService.ACTION_START, true);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve(toJSObject(true, 0));
        } catch (RuntimeException exception) {
            running = false;
            call.reject("无法启动原生节拍服务。", exception);
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        try {
            boolean restartPattern = call.getBoolean("restartPattern", false);
            readConfiguration(call, restartPattern);
            if (running) {
                Intent intent = createConfigurationIntent(call, BackgroundMetronomeService.ACTION_UPDATE, restartPattern);
                getContext().startService(intent);
            }
            call.resolve(toJSObject(running, restartPattern ? 80 : 0));
        } catch (RuntimeException exception) {
            call.reject("无法更新原生节拍配置。", exception);
        }
    }

    @PluginMethod
    public void updateSound(PluginCall call) {
        try {
            volume = clampFloat(call.getDouble("volume", (double) volume).floatValue(), BackgroundMetronomeService.MIN_VOLUME, BackgroundMetronomeService.MAX_VOLUME);
            brightness = clampFloat(call.getDouble("brightness", (double) brightness).floatValue(), 0.5f, 2.0f);
            kick = clampFloat(call.getDouble("kick", (double) kick).floatValue(), 0.5f, 1.5f);
            snare = clampFloat(call.getDouble("snare", (double) snare).floatValue(), 0.5f, 1.5f);
            hat = clampFloat(call.getDouble("hat", (double) hat).floatValue(), 0.5f, 1.5f);

            BackgroundMetronomeService.Snapshot nativeSnapshot = BackgroundMetronomeService.getSnapshot();
            if (nativeSnapshot != null && nativeSnapshot.running) {
                running = true;
                Intent intent = BackgroundMetronomeService.createIntent(
                    getContext(),
                    BackgroundMetronomeService.ACTION_UPDATE
                );
                intent.putExtra("volume", volume);
                intent.putExtra("brightness", brightness);
                intent.putExtra("kick", kick);
                intent.putExtra("snare", snare);
                intent.putExtra("hat", hat);
                intent.putExtra("restartPattern", false);
                getContext().startService(intent);
            }

            call.resolve(toJSObject(running, 0));
        } catch (RuntimeException exception) {
            call.reject("无法实时更新节拍器音色。", exception);
        }
    }

    @PluginMethod
    public void setTone(PluginCall call) {
        try {
            toneId = BackgroundMetronomeService.normalizeToneId(
                call.getString("toneId", toneId)
            );
            BackgroundMetronomeService.saveToneId(getContext(), toneId);
            if (running) {
                Intent intent = BackgroundMetronomeService.createIntent(
                    getContext(),
                    BackgroundMetronomeService.ACTION_UPDATE
                );
                intent.putExtra("toneId", toneId);
                getContext().startService(intent);
            }
            call.resolve(toJSObject(running, 0));
        } catch (RuntimeException exception) {
            call.reject("无法更新节拍器音色。", exception);
        }
    }

    @PluginMethod
    public void pause(PluginCall call) {
        stopNativeService();
        running = false;
        call.resolve(toJSObject(false, 0));
    }

    @PluginMethod
    public void reset(PluginCall call) {
        stopNativeService();
        running = false;
        beatIndex = 1;
        nextBeatIndex = 2;
        call.resolve(toJSObject(false, 0));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopNativeService();
        running = false;
        call.resolve(toJSObject(false, 0));
    }

    @PluginMethod
    public void getState(PluginCall call) {
        BackgroundMetronomeService.Snapshot nativeSnapshot = BackgroundMetronomeService.getSnapshot();
        if (nativeSnapshot != null && nativeSnapshot.running) {
            syncConfiguration(nativeSnapshot);
            call.resolve(withLiveDelay(nativeSnapshot));
            return;
        }
        call.resolve(toJSObject(running, 0));
    }

    @PluginMethod
    public void preview(PluginCall call) {
        try {
            BackgroundMetronomeService.playPreview(
                getContext(),
                BackgroundMetronomeService.normalizeToneId(call.getString("toneId", toneId)),
                clampFloat(call.getDouble("volume", (double) volume).floatValue(), BackgroundMetronomeService.MIN_VOLUME, BackgroundMetronomeService.MAX_VOLUME),
                clampFloat(call.getDouble("brightness", (double) brightness).floatValue(), 0.5f, 2.0f),
                clampFloat(call.getDouble("kick", (double) kick).floatValue(), 0.5f, 1.5f),
                clampFloat(call.getDouble("snare", (double) snare).floatValue(), 0.5f, 1.5f),
                clampFloat(call.getDouble("hat", (double) hat).floatValue(), 0.5f, 1.5f)
            );
            call.resolve();
        } catch (RuntimeException exception) {
            call.reject("无法播放原生音色试听。", exception);
        }
    }

    @PluginMethod
    public void checkNotificationPermission(PluginCall call) {
        JSObject result = new JSObject();
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED;
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }

        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }

        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        PowerManager powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        boolean ignoring = powerManager != null
            && powerManager.isIgnoringBatteryOptimizations(getContext().getPackageName());
        JSObject result = new JSObject();
        result.put("ignoring", ignoring);
        call.resolve(result);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception exception) {
            call.reject("无法打开电池优化设置。", exception);
        }
    }

    private Intent createConfigurationIntent(PluginCall call, String action, boolean restartPattern) {
        Intent intent = BackgroundMetronomeService.createIntent(getContext(), action);
        intent.putExtra("bpm", bpm);
        intent.putExtra("beatsPerBar", beatsPerBar);
        intent.putExtra("denominator", denominator);
        intent.putExtra("toneId", toneId);
        intent.putExtra("currentBeatIndex", beatIndex);
        intent.putExtra("nextBeatIndex", nextBeatIndex);
        intent.putExtra("startDelayMs", call.getInt("startDelayMs", 80));
        intent.putExtra("requestedAtElapsedRealtime", SystemClock.elapsedRealtime());
        intent.putExtra("restartPattern", restartPattern);
        intent.putExtra("accentPattern", joinPattern(accentPattern));
        intent.putExtra("volume", volume);
        intent.putExtra("brightness", brightness);
        intent.putExtra("kick", kick);
        intent.putExtra("snare", snare);
        intent.putExtra("hat", hat);
        return intent;
    }

    private void readConfiguration(PluginCall call, boolean restartPattern) {
        bpm = clamp(call.getInt("bpm", bpm), 30, 350);
        beatsPerBar = clamp(call.getInt("beatsPerBar", beatsPerBar), 2, 12);
        denominator = clamp(call.getInt("denominator", denominator), 4, 8);
        String requestedToneId = call.getString("toneId");
        if (requestedToneId != null) {
            toneId = BackgroundMetronomeService.normalizeToneId(requestedToneId);
        }
        if (restartPattern) {
            beatIndex = clamp(call.getInt("currentBeatIndex", 1), 1, beatsPerBar);
            nextBeatIndex = clamp(
                call.getInt("nextBeatIndex", advanceBeatIndex(beatIndex, beatsPerBar)),
                1,
                beatsPerBar
            );
        } else {
            beatIndex = clamp(beatIndex, 1, beatsPerBar);
            nextBeatIndex = clamp(nextBeatIndex, 1, beatsPerBar);
        }
        accentPattern = parsePattern(call.getString("accentPattern"), beatsPerBar);
        volume = clampFloat(call.getDouble("volume", (double) volume).floatValue(), BackgroundMetronomeService.MIN_VOLUME, BackgroundMetronomeService.MAX_VOLUME);
        brightness = clampFloat(call.getDouble("brightness", (double) brightness).floatValue(), 0.5f, 2.0f);
        kick = clampFloat(call.getDouble("kick", (double) kick).floatValue(), 0.5f, 1.5f);
        snare = clampFloat(call.getDouble("snare", (double) snare).floatValue(), 0.5f, 1.5f);
        hat = clampFloat(call.getDouble("hat", (double) hat).floatValue(), 0.5f, 1.5f);
    }

    private void stopNativeService() {
        Context context = getContext();
        Intent intent = BackgroundMetronomeService.createIntent(context, BackgroundMetronomeService.ACTION_STOP);
        if (BackgroundMetronomeService.getSnapshot().running) {
            context.startService(intent);
        } else {
            context.stopService(intent);
        }
    }

    private void syncConfiguration(BackgroundMetronomeService.Snapshot snapshot) {
        if (snapshot == null) {
            return;
        }
        bpm = snapshot.bpm;
        beatsPerBar = snapshot.beatsPerBar;
        denominator = snapshot.denominator;
        toneId = BackgroundMetronomeService.normalizeToneId(snapshot.toneId);
        beatIndex = snapshot.beatIndex;
        nextBeatIndex = snapshot.nextBeatIndex;
        accentPattern = parsePattern(snapshot.accentPattern, beatsPerBar);
        volume = snapshot.volume;
        running = snapshot.running;
    }

    private int[] parsePattern(String pattern, int length) {
        int[] parsed = new int[length];
        parsed[0] = 2;
        if (pattern == null || pattern.isEmpty()) {
            return parsed;
        }
        String[] parts = pattern.split(",");
        for (int index = 0; index < length; index += 1) {
            if (index >= parts.length) {
                break;
            }
            try {
                parsed[index] = clamp(Integer.parseInt(parts[index].trim()), 0, 2);
            } catch (NumberFormatException ignored) {
                parsed[index] = 0;
            }
        }
        return parsed;
    }

    private JSObject toJSObject(boolean isRunning, int nextBeatDelayMs) {
        JSObject result = new JSObject();
        result.put("running", isRunning);
        result.put("bpm", bpm);
        result.put("beatsPerBar", beatsPerBar);
        result.put("denominator", denominator);
        result.put("toneId", toneId);
        result.put("beatIndex", clamp(beatIndex, 1, beatsPerBar));
        result.put("nextBeatIndex", clamp(nextBeatIndex, 1, beatsPerBar));
        result.put("accentPattern", joinPattern(accentPattern));
        result.put("volume", volume);
        result.put("nextBeatDelayMs", Math.max(0, nextBeatDelayMs));
        return result;
    }

    private JSObject toJSObject(BackgroundMetronomeService.Snapshot snapshot) {
        JSObject result = toJSObject(snapshot.running, snapshot.nextBeatDelayMs);
        result.put("bpm", snapshot.bpm);
        result.put("beatsPerBar", snapshot.beatsPerBar);
        result.put("denominator", snapshot.denominator);
        result.put("toneId", snapshot.toneId);
        result.put("beatIndex", snapshot.beatIndex);
        result.put("nextBeatIndex", snapshot.nextBeatIndex);
        result.put("accentPattern", snapshot.accentPattern);
        result.put("volume", snapshot.volume);
        return result;
    }

    private JSObject withLiveDelay(BackgroundMetronomeService.Snapshot snapshot) {
        JSObject result = toJSObject(snapshot);
        long snapshotAgeMs = Math.max(0, SystemClock.elapsedRealtime() - snapshot.capturedAtElapsedRealtimeMs);
        int liveDelayMs = (int) Math.max(0, snapshot.nextBeatDelayMs - snapshotAgeMs);
        result.put("nextBeatDelayMs", liveDelayMs);
        return result;
    }

    private void notifyOnMainThread(String eventName, JSObject payload) {
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> notifyListeners(eventName, payload));
            return;
        }
        notifyListeners(eventName, payload);
    }

    private int advanceBeatIndex(int currentBeatIndex, int currentBeatsPerBar) {
        return currentBeatIndex >= currentBeatsPerBar ? 1 : currentBeatIndex + 1;
    }

    private String joinPattern(int[] pattern) {
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < pattern.length; index += 1) {
            if (index > 0) {
                builder.append(',');
            }
            builder.append(pattern[index]);
        }
        return builder.toString();
    }

    private int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    private float clampFloat(float value, float minimum, float maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }
}
