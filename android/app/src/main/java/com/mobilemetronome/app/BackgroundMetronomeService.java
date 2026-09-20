package com.mobilemetronome.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTimestamp;
import android.media.AudioTrack;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Random;

public class BackgroundMetronomeService extends Service {
    public static final String ACTION_START = "com.mobilemetronome.app.action.START_BACKGROUND_METRONOME";
    public static final String ACTION_UPDATE = "com.mobilemetronome.app.action.UPDATE_BACKGROUND_METRONOME";
    public static final String ACTION_STOP = "com.mobilemetronome.app.action.STOP_BACKGROUND_METRONOME";
    public static final String TONE_DRUM_MACHINE = "drum-machine";
    public static final String TONE_MECHANICAL = "mechanical";
    public static final float MIN_VOLUME = 0.5f;
    public static final float MAX_VOLUME = 10.0f;

    private static final String TAG = "BackgroundMetronome";
    private static final String CHANNEL_ID = "metronome_background";
    private static final int NOTIFICATION_ID = 4301;
    private static final String PREFS_NAME = "background_metronome";
    private static final int SAMPLE_RATE = 44100;
    private static final int PCM_BUFFER_FRAMES = 1024;
    private static final int TARGET_BUFFER_MS = 250;
    private static final int DEFAULT_START_DELAY_MS = 80;
    private static final int MIN_START_DELAY_MS = 20;
    private static final int MAX_START_DELAY_MS = 10000;
    private static final int AUDIO_EVENT_LEAD_MS = 120;
    private static final int PREVIEW_START_DELAY_MS = 160;

    public interface EventListener {
        void onBeat(
            int beatIndex,
            int beatsPerBar,
            int denominator,
            int accentLevel,
            long framePosition,
            long audibleAtEpochMs
        );
        void onStateChanged(Snapshot snapshot);
        default void onPreviewBeat(
            int beatIndex,
            int beatsPerBar,
            int accentLevel,
            long framePosition,
            long audibleAtEpochMs
        ) {}
        default void onPreviewFinished() {}
    }

    private static volatile Snapshot snapshot = new Snapshot(
        false,
        120,
        4,
        4,
        1,
        2,
        5.0f,
        0,
        "2,0,0,0",
        TONE_MECHANICAL,
        SystemClock.elapsedRealtime()
    );
    private static volatile EventListener eventListener;

    private volatile boolean running = false;
    private volatile int bpm = 120;
    private volatile int beatsPerBar = 4;
    private volatile int denominator = 4;
    private volatile String toneId = TONE_MECHANICAL;
    private volatile int lastBeatIndex = 1;
    private volatile int nextBeatIndex = 2;
    private volatile int[] accentPattern = new int[] { 2, 0, 0, 0 };
    private volatile String accentPatternSerialized = "2,0,0,0";
    private volatile float masterVolume = 5.0f;
    private volatile float brightness = 1.0f;
    private volatile float kickLevel = 1.5f;
    private volatile float snareLevel = 1.5f;
    private volatile float hatLevel = 1.0f;
    private volatile int startDelayMs = DEFAULT_START_DELAY_MS;
    private volatile boolean restartPatternRequested = false;
    private volatile long synthConfigRevision = 1;

    private AudioTrack audioTrack;
    private Thread renderThread;
    private PowerManager.WakeLock wakeLock;

    public static Snapshot getSnapshot() {
        return snapshot;
    }

    public static void setEventListener(EventListener listener) {
        eventListener = listener;
    }

    public static Intent createIntent(Context context, String action) {
        Intent intent = new Intent(context, BackgroundMetronomeService.class);
        intent.setAction(action);
        return intent;
    }

    public static String normalizeToneId(String value) {
        if (TONE_DRUM_MACHINE.equals(value)) {
            return TONE_DRUM_MACHINE;
        }
        return TONE_MECHANICAL;
    }

    public static String loadToneId(Context context) {
        return normalizeToneId(
            context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString("toneId", TONE_MECHANICAL)
        );
    }

    public static void saveToneId(Context context, String value) {
        context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putString("toneId", normalizeToneId(value))
            .apply();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
            stopPlayback();
            return START_NOT_STICKY;
        }

        boolean configurationOnly = ACTION_UPDATE.equals(action);
        if (intent == null) {
            loadSavedState();
            lastBeatIndex = nextBeatIndex;
            nextBeatIndex = lastBeatIndex >= beatsPerBar ? 1 : lastBeatIndex + 1;
            startDelayMs = DEFAULT_START_DELAY_MS;
        } else {
            readConfiguration(intent, configurationOnly);
            saveState();
        }

        if (configurationOnly && !running) {
            publishSnapshot(false, 0);
            notifyStateChanged();
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        startForegroundNotification();
        startRenderThread();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopPlayback();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void readConfiguration(Intent intent, boolean configurationOnly) {
        bpm = clamp(intent.getIntExtra("bpm", bpm), 30, 350);
        beatsPerBar = clamp(intent.getIntExtra("beatsPerBar", beatsPerBar), 2, 12);
        denominator = clamp(intent.getIntExtra("denominator", denominator), 4, 8);
        String requestedToneId = intent.getStringExtra("toneId");
        if (requestedToneId != null) {
            toneId = normalizeToneId(requestedToneId);
        }

        boolean restartPattern = !configurationOnly || intent.getBooleanExtra("restartPattern", false);
        if (restartPattern) {
            lastBeatIndex = clamp(intent.getIntExtra("currentBeatIndex", 1), 1, beatsPerBar);
            nextBeatIndex = clamp(
                intent.getIntExtra(
                    "nextBeatIndex",
                    lastBeatIndex >= beatsPerBar ? 1 : lastBeatIndex + 1
                ),
                1,
                beatsPerBar
            );
        }

        masterVolume = clampFloat(intent.getFloatExtra("volume", masterVolume), MIN_VOLUME, MAX_VOLUME);
        brightness = clampFloat(intent.getFloatExtra("brightness", brightness), 0.5f, 2.0f);
        kickLevel = clampFloat(intent.getFloatExtra("kick", kickLevel), 0.5f, 1.5f);
        snareLevel = clampFloat(intent.getFloatExtra("snare", snareLevel), 0.5f, 1.5f);
        hatLevel = clampFloat(intent.getFloatExtra("hat", hatLevel), 0.5f, 1.5f);

        if (restartPattern) {
            long now = SystemClock.elapsedRealtime();
            long requestedAt = intent.getLongExtra("requestedAtElapsedRealtime", now);
            int requestedDelayMs = clamp(
                intent.getIntExtra("startDelayMs", DEFAULT_START_DELAY_MS),
                MIN_START_DELAY_MS,
                MAX_START_DELAY_MS
            );
            int serviceStartupMs = (int) Math.max(0, now - requestedAt);
            startDelayMs = Math.max(MIN_START_DELAY_MS, requestedDelayMs - serviceStartupMs);
            restartPatternRequested = configurationOnly;
        }

        String pattern = intent.getStringExtra("accentPattern");
        if (pattern != null) {
            accentPattern = parsePattern(pattern, beatsPerBar);
            accentPatternSerialized = joinPattern(accentPattern);
        }
        synthConfigRevision += 1;
        publishSnapshot(running, restartPattern ? startDelayMs : 0);
        if (running) {
            notifyStateChanged();
        }
    }

    private int[] parsePattern(String pattern, int length) {
        int[] parsed = new int[length];
        if (pattern == null || pattern.isEmpty()) {
            parsed[0] = 2;
            return parsed;
        }
        String[] parts = pattern.split(",");
        for (int index = 0; index < length; index += 1) {
            if (index < parts.length) {
                try {
                    parsed[index] = clamp(Integer.parseInt(parts[index].trim()), 0, 2);
                } catch (NumberFormatException ignored) {
                    parsed[index] = 0;
                }
            }
        }
        return parsed;
    }

    private void startRenderThread() {
        if (running) {
            return;
        }
        acquireWakeLock();
        running = true;
        publishSnapshot(true, startDelayMs);
        notifyStateChanged();
        renderThread = new Thread(this::renderLoop, "background-metronome-audio");
        renderThread.start();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Metronome::BackgroundAudio");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
    }

    private void renderLoop() {
        try {
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        } catch (SecurityException ignored) {
        } catch (IllegalArgumentException ignored) {
        }

        AudioTrack track = null;
        try {
            int minBufferSize = AudioTrack.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            );
            int targetBufferBytes = (SAMPLE_RATE * 2 * TARGET_BUFFER_MS) / 1000;
            int bufferSize = Math.max(minBufferSize, targetBufferBytes);

            track = new AudioTrack.Builder()
                .setAudioAttributes(
                    new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                .setAudioFormat(
                    new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();

            audioTrack = track;
            DrumSynth synth = new DrumSynth(SAMPLE_RATE);
            short[] buffer = new short[PCM_BUFFER_FRAMES];
            Deque<BeatEvent> scheduledBeats = new ArrayDeque<>();
            Deque<BeatEvent> announcedBeats = new ArrayDeque<>();
            AudioTimestamp audioTimestamp = new AudioTimestamp();
            long framePosition = 0;
            long appliedConfigRevision = 0;
            long nextBeatFrame = Math.max(
                1,
                Math.round((startDelayMs / 1000.0) * SAMPLE_RATE)
            );
            int pendingBeatIndex = clamp(lastBeatIndex, 1, beatsPerBar);
            int audibleBeatIndex = clamp(lastBeatIndex, 1, beatsPerBar);

            track.play();
            while (running) {
                if (restartPatternRequested) {
                    restartPatternRequested = false;
                    scheduledBeats.clear();
                    announcedBeats.clear();
                    pendingBeatIndex = clamp(lastBeatIndex, 1, beatsPerBar);
                    long restartDelayFrames = Math.max(
                        1,
                        Math.round((startDelayMs / 1000.0) * SAMPLE_RATE)
                    );
                    nextBeatFrame = framePosition + restartDelayFrames;
                }

                int currentBeatsPerBar = beatsPerBar;
                int currentDenominator = denominator;
                int currentBpm = bpm;
                long configRevision = synthConfigRevision;

                if (appliedConfigRevision != configRevision) {
                    synth.setTone(toneId);
                    synth.configure(masterVolume, brightness, kickLevel, snareLevel, hatLevel);
                    appliedConfigRevision = configRevision;
                }

                for (int index = 0; index < buffer.length && running; index += 1) {
                    while (framePosition >= nextBeatFrame) {
                        int beatIndex = clamp(pendingBeatIndex, 1, currentBeatsPerBar);
                        int accentLevel = accentPattern[beatIndex - 1];
                        boolean sixEightSpecialBeat = currentBeatsPerBar == 6
                            && currentDenominator == 8
                            && beatIndex == 4;
                        synth.trigger(accentLevel, sixEightSpecialBeat);
                        scheduledBeats.addLast(new BeatEvent(nextBeatFrame, beatIndex, accentLevel));
                        pendingBeatIndex = beatIndex >= currentBeatsPerBar ? 1 : beatIndex + 1;
                        nextBeatFrame += Math.round((60.0 / currentBpm) * SAMPLE_RATE);
                    }

                    buffer[index] = (short) (synth.nextSample() * Short.MAX_VALUE);
                    framePosition += 1;
                }

                long audibleFrame = estimateAudibleFrame(track, framePosition, audioTimestamp);
                long leadFrames = Math.round((AUDIO_EVENT_LEAD_MS / 1000.0) * SAMPLE_RATE);
                while (
                    !scheduledBeats.isEmpty()
                        && scheduledBeats.peekFirst().frame <= audibleFrame + leadFrames
                ) {
                    BeatEvent event = scheduledBeats.removeFirst();
                    announcedBeats.addLast(event);
                    notifyBeat(
                        event.beatIndex,
                        currentBeatsPerBar,
                        denominator,
                        event.accentLevel,
                        event.frame,
                        estimateEpochTimeForFrame(track, event.frame, audibleFrame)
                    );
                }

                boolean beatBecameAudible = false;
                while (!announcedBeats.isEmpty() && announcedBeats.peekFirst().frame <= audibleFrame) {
                    BeatEvent event = announcedBeats.removeFirst();
                    audibleBeatIndex = event.beatIndex;
                    beatBecameAudible = true;
                }

                if (beatBecameAudible) {
                    BeatEvent nextEvent = !announcedBeats.isEmpty()
                        ? announcedBeats.peekFirst()
                        : scheduledBeats.peekFirst();
                    long nextAudibleFrame = nextEvent != null ? nextEvent.frame : nextBeatFrame;
                    int nextAudibleBeatIndex = nextEvent != null ? nextEvent.beatIndex : pendingBeatIndex;
                    int nextBeatDelayMs = (int) Math.max(
                        0,
                        Math.round(((nextAudibleFrame - audibleFrame) * 1000.0) / SAMPLE_RATE)
                    );

                    lastBeatIndex = audibleBeatIndex;
                    nextBeatIndex = clamp(nextAudibleBeatIndex, 1, currentBeatsPerBar);
                    publishSnapshot(true, nextBeatDelayMs);
                }

                if (!writeFully(track, buffer, buffer.length)) {
                    break;
                }
            }
        } catch (Exception exception) {
            Log.e(TAG, "后台音频渲染失败。", exception);
        } finally {
            if (track != null) {
                try {
                    track.stop();
                } catch (IllegalStateException ignored) {
                }
                track.release();
            }
            if (audioTrack == track) {
                audioTrack = null;
            }
            running = false;
            publishSnapshot(false, 0);
            notifyStateChanged();
            releaseWakeLock();
        }
    }

    private boolean writeFully(AudioTrack track, short[] buffer, int count) {
        int offset = 0;
        while (offset < count && running) {
            int written = track.write(buffer, offset, count - offset, AudioTrack.WRITE_BLOCKING);
            if (written < 0) {
                Log.e(TAG, "AudioTrack.write 返回错误：" + written);
                return false;
            }
            if (written == 0) {
                continue;
            }
            offset += written;
        }
        return true;
    }

    private static long estimateAudibleFrame(AudioTrack track, long renderedFrame, AudioTimestamp timestamp) {
        if (track.getTimestamp(timestamp) && timestamp.nanoTime > 0) {
            long elapsedNanos = Math.max(0, System.nanoTime() - timestamp.nanoTime);
            long estimated = timestamp.framePosition + (elapsedNanos * SAMPLE_RATE) / 1_000_000_000L;
            return Math.max(0, Math.min(renderedFrame, estimated));
        }
        long playbackHead = track.getPlaybackHeadPosition() & 0xffffffffL;
        return Math.max(0, Math.min(renderedFrame, playbackHead));
    }

    private static long estimateEpochTimeForFrame(
        AudioTrack track,
        long targetFrame,
        long fallbackAudibleFrame
    ) {
        long nowEpochMs = System.currentTimeMillis();
        AudioTimestamp timestamp = new AudioTimestamp();
        if (track.getTimestamp(timestamp) && timestamp.nanoTime > 0) {
            long targetNanos = timestamp.nanoTime
                + ((targetFrame - timestamp.framePosition) * 1_000_000_000L) / SAMPLE_RATE;
            long targetEpochMs = nowEpochMs + Math.round((targetNanos - System.nanoTime()) / 1_000_000.0);
            return Math.max(nowEpochMs, targetEpochMs);
        }
        long delayFrames = Math.max(0, targetFrame - fallbackAudibleFrame);
        return nowEpochMs + Math.round((delayFrames * 1000.0) / SAMPLE_RATE);
    }

    private void stopPlayback() {
        running = false;
        AudioTrack track = audioTrack;
        if (track != null) {
            try {
                track.pause();
                track.flush();
            } catch (IllegalStateException ignored) {
            }
        }

        Thread thread = renderThread;
        if (thread != null) {
            try {
                thread.join(600);
            } catch (InterruptedException interruptedException) {
                Thread.currentThread().interrupt();
            }
        }
        renderThread = null;
        audioTrack = null;
        releaseWakeLock();
        accentPatternSerialized = joinPattern(accentPattern);
        synthConfigRevision += 1;
        publishSnapshot(false, 0);
        notifyStateChanged();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void publishSnapshot(boolean isRunning, int nextBeatDelayMs) {
        snapshot = new Snapshot(
            isRunning,
            bpm,
            beatsPerBar,
            denominator,
            lastBeatIndex,
            nextBeatIndex,
            masterVolume,
            Math.max(0, nextBeatDelayMs),
            accentPatternSerialized,
            toneId,
            SystemClock.elapsedRealtime()
        );
    }

    private void notifyBeat(
        int beatIndex,
        int currentBeatsPerBar,
        int currentDenominator,
        int accentLevel,
        long framePosition,
        long audibleAtEpochMs
    ) {
        EventListener listener = eventListener;
        if (listener == null) {
            return;
        }
        try {
            listener.onBeat(
                beatIndex,
                currentBeatsPerBar,
                currentDenominator,
                accentLevel,
                framePosition,
                audibleAtEpochMs
            );
        } catch (RuntimeException exception) {
            Log.w(TAG, "节拍事件发送失败。", exception);
        }
    }

    private void notifyStateChanged() {
        EventListener listener = eventListener;
        if (listener == null) {
            return;
        }
        try {
            listener.onStateChanged(snapshot);
        } catch (RuntimeException exception) {
            Log.w(TAG, "节拍状态事件发送失败。", exception);
        }
    }

    private void startForegroundNotification() {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("后台节拍运行中")
            .setContentText(bpm + " BPM · " + beatsPerBar + "/" + denominator)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .addAction(0, "停止", createStopPendingIntent())
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();

        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                : 0
        );
    }

    private PendingIntent createStopPendingIntent() {
        Intent stopIntent = createIntent(this, ACTION_STOP);
        return PendingIntent.getService(
            this,
            4302,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "后台节拍",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("保持节拍器在后台持续播放");
        channel.setSound(null, null);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void saveState() {
        SharedPreferences preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        preferences.edit()
            .putInt("bpm", bpm)
            .putInt("beatsPerBar", beatsPerBar)
            .putInt("denominator", denominator)
            .putString("toneId", toneId)
            .putInt("lastBeatIndex", lastBeatIndex)
            .putInt("nextBeatIndex", nextBeatIndex)
            .putFloat("volume", masterVolume)
            .putFloat("brightness", brightness)
            .putFloat("kick", kickLevel)
            .putFloat("snare", snareLevel)
            .putFloat("hat", hatLevel)
            .putString("accentPattern", joinPattern(accentPattern))
            .apply();
    }

    private void loadSavedState() {
        SharedPreferences preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        bpm = clamp(preferences.getInt("bpm", bpm), 30, 350);
        beatsPerBar = clamp(preferences.getInt("beatsPerBar", beatsPerBar), 2, 12);
        denominator = clamp(preferences.getInt("denominator", denominator), 4, 8);
        toneId = normalizeToneId(preferences.getString("toneId", toneId));
        lastBeatIndex = clamp(preferences.getInt("lastBeatIndex", lastBeatIndex), 1, beatsPerBar);
        nextBeatIndex = clamp(preferences.getInt("nextBeatIndex", nextBeatIndex), 1, beatsPerBar);
        masterVolume = clampFloat(preferences.getFloat("volume", masterVolume), MIN_VOLUME, MAX_VOLUME);
        brightness = clampFloat(preferences.getFloat("brightness", brightness), 0.5f, 2.0f);
        kickLevel = clampFloat(preferences.getFloat("kick", kickLevel), 0.5f, 1.5f);
        snareLevel = clampFloat(preferences.getFloat("snare", snareLevel), 0.5f, 1.5f);
        hatLevel = clampFloat(preferences.getFloat("hat", hatLevel), 0.5f, 1.5f);
        accentPattern = parsePattern(preferences.getString("accentPattern", null), beatsPerBar);
        accentPatternSerialized = joinPattern(accentPattern);
        synthConfigRevision += 1;
        publishSnapshot(false, 0);
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

    public static void playPreview(
        Context context,
        String requestedToneId,
        float volume,
        float brightness,
        float kick,
        float snare,
        float hat
    ) {
        Thread previewThread = new Thread(() -> {
            AudioTrack track = null;
            try {
                int minBufferSize = AudioTrack.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
                );
                int targetBufferBytes = (SAMPLE_RATE * 2 * TARGET_BUFFER_MS) / 1000;
                track = new AudioTrack.Builder()
                    .setAudioAttributes(
                        new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build()
                    )
                    .setAudioFormat(
                        new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(SAMPLE_RATE)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build()
                    )
                    .setBufferSizeInBytes(Math.max(minBufferSize, targetBufferBytes))
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();

                DrumSynth synth = new DrumSynth(SAMPLE_RATE);
                synth.setTone(normalizeToneId(requestedToneId));
                synth.configure(volume, brightness, kick, snare, hat);
                short[] buffer = new short[PCM_BUFFER_FRAMES];
                int[] previewAccents = new int[] { 2, 0, 0, 1, 0, 0 };
                int beatFrames = Math.round(SAMPLE_RATE * 0.5f);
                long previewStartFrame = Math.max(
                    1,
                    Math.round((PREVIEW_START_DELAY_MS / 1000.0) * SAMPLE_RATE)
                );
                long totalFrames = previewStartFrame + (long) beatFrames * previewAccents.length;
                long nextBeatFrame = previewStartFrame;
                long framePosition = 0;
                int pendingBeatIndex = 0;
                long leadFrames = Math.round((AUDIO_EVENT_LEAD_MS / 1000.0) * SAMPLE_RATE);
                Deque<BeatEvent> scheduledBeats = new ArrayDeque<>();
                AudioTimestamp audioTimestamp = new AudioTimestamp();

                track.play();
                while (framePosition < totalFrames) {
                    int frameCount = (int) Math.min(buffer.length, totalFrames - framePosition);
                    for (int index = 0; index < frameCount; index += 1) {
                        while (
                            pendingBeatIndex < previewAccents.length
                                && framePosition >= nextBeatFrame
                        ) {
                            int accentLevel = previewAccents[pendingBeatIndex];
                            synth.trigger(accentLevel, pendingBeatIndex == 3);
                            scheduledBeats.addLast(
                                new BeatEvent(nextBeatFrame, pendingBeatIndex + 1, accentLevel)
                            );
                            pendingBeatIndex += 1;
                            nextBeatFrame += beatFrames;
                        }

                        buffer[index] = (short) (synth.nextSample() * Short.MAX_VALUE);
                        framePosition += 1;
                    }

                    if (!writePreviewFully(track, buffer, frameCount)) {
                        return;
                    }

                    long audibleFrame = estimateAudibleFrame(track, framePosition, audioTimestamp);
                    announcePreviewBeats(
                        track,
                        scheduledBeats,
                        audibleFrame,
                        previewAccents.length,
                        leadFrames
                    );
                }

                long drainDeadlineMs = SystemClock.elapsedRealtime() + 1500;
                while (SystemClock.elapsedRealtime() < drainDeadlineMs) {
                    long audibleFrame = estimateAudibleFrame(track, framePosition, audioTimestamp);
                    announcePreviewBeats(
                        track,
                        scheduledBeats,
                        audibleFrame,
                        previewAccents.length,
                        leadFrames
                    );
                    if (audibleFrame >= totalFrames) {
                        break;
                    }
                    try {
                        Thread.sleep(5);
                    } catch (InterruptedException interruptedException) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            } catch (Exception exception) {
                Log.e(TAG, "Native sound preview failed.", exception);
            } finally {
                if (track != null) {
                    try {
                        track.stop();
                    } catch (IllegalStateException ignored) {
                    }
                    track.release();
                }
                notifyPreviewFinished();
            }
        }, "native-metronome-preview");
        previewThread.start();
    }

    private static boolean writePreviewFully(AudioTrack track, short[] buffer, int count) {
        int offset = 0;
        while (offset < count) {
            int written = track.write(buffer, offset, count - offset, AudioTrack.WRITE_BLOCKING);
            if (written < 0) {
                Log.e(TAG, "AudioTrack.write preview error: " + written);
                return false;
            }
            if (written == 0) {
                continue;
            }
            offset += written;
        }
        return true;
    }

    private static void announcePreviewBeats(
        AudioTrack track,
        Deque<BeatEvent> scheduledBeats,
        long audibleFrame,
        int beatsPerBar,
        long leadFrames
    ) {
        while (!scheduledBeats.isEmpty() && scheduledBeats.peekFirst().frame <= audibleFrame + leadFrames) {
            BeatEvent event = scheduledBeats.removeFirst();
            notifyPreviewBeat(
                event.beatIndex,
                beatsPerBar,
                event.accentLevel,
                event.frame,
                estimateEpochTimeForFrame(track, event.frame, audibleFrame)
            );
        }
    }

    private static void notifyPreviewBeat(
        int beatIndex,
        int beatsPerBar,
        int accentLevel,
        long framePosition,
        long audibleAtEpochMs
    ) {
        EventListener listener = eventListener;
        if (listener == null) {
            return;
        }
        try {
            listener.onPreviewBeat(
                beatIndex,
                beatsPerBar,
                accentLevel,
                framePosition,
                audibleAtEpochMs
            );
        } catch (RuntimeException exception) {
            Log.w(TAG, "Preview beat event delivery failed.", exception);
        }
    }

    private static void notifyPreviewFinished() {
        EventListener listener = eventListener;
        if (listener == null) {
            return;
        }
        try {
            listener.onPreviewFinished();
        } catch (RuntimeException exception) {
            Log.w(TAG, "Preview completion event delivery failed.", exception);
        }
    }

    private int clamp(int value, int minimum, int maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    private float clampFloat(float value, float minimum, float maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    public static final class Snapshot {
        public final boolean running;
        public final int bpm;
        public final int beatsPerBar;
        public final int denominator;
        public final int beatIndex;
        public final int nextBeatIndex;
        public final float volume;
        public final int nextBeatDelayMs;
        public final String accentPattern;
        public final String toneId;
        public final long capturedAtElapsedRealtimeMs;

        Snapshot(
            boolean running,
            int bpm,
            int beatsPerBar,
            int denominator,
            int beatIndex,
            int nextBeatIndex,
            float volume,
            int nextBeatDelayMs,
            String accentPattern,
            String toneId,
            long capturedAtElapsedRealtimeMs
        ) {
            this.running = running;
            this.bpm = bpm;
            this.beatsPerBar = beatsPerBar;
            this.denominator = denominator;
            this.beatIndex = beatIndex;
            this.nextBeatIndex = nextBeatIndex;
            this.volume = volume;
            this.nextBeatDelayMs = nextBeatDelayMs;
            this.accentPattern = accentPattern;
            this.toneId = toneId;
            this.capturedAtElapsedRealtimeMs = capturedAtElapsedRealtimeMs;
        }
    }

    private static final class BeatEvent {
        private final long frame;
        private final int beatIndex;
        private final int accentLevel;

        private BeatEvent(long frame, int beatIndex, int accentLevel) {
            this.frame = frame;
            this.beatIndex = beatIndex;
            this.accentLevel = accentLevel;
        }
    }

    private static final class FilterState {
        private double previousInput;
        private double previousOutput;
    }

    static final class DrumSynth {
        private static final double TWO_PI = Math.PI * 2;
        private static final double COMPRESSOR_THRESHOLD = Math.pow(10, -4.0 / 20.0);
        private static final double LIMITER_THRESHOLD = 0.55;
        private static final double LIMITER_CEILING = 0.99;
        private static final double LIMITER_NORMALIZATION = Math.tanh(2);
        private static final double MECHANICAL_DING_DURATION = 0.105;
        private static final double MECHANICAL_DI_DURATION = 0.030;
        private static final double MECHANICAL_SPECIAL_DURATION = 0.042;

        private final double sampleRate;
        private final double inverseSampleRate;
        private final double twoPiOverSampleRate;
        private final Random random = new Random();
        private final FilterState kickPresenceFilter = new FilterState();
        private final FilterState snareNoiseFilter = new FilterState();
        private final FilterState hatFilter = new FilterState();
        private final FilterState mechanicalNoiseFilter = new FilterState();

        private double kickBodyTime = -1;
        private double kickBodyPhase = 0;
        private double kickClickTime = -1;
        private double kickClickPhase = 0;
        private double kickPresenceTime = -1;
        private double tomTime = -1;
        private double tomPhase = 0;
        private double snareToneTime = -1;
        private double snareTonePhase = 0;
        private double snareNoiseTime = -1;
        private double hatTime = -1;
        private double mechanicalDingTime = -1;
        private double mechanicalDingPhase1 = 0;
        private double mechanicalDingPhase2 = 0;
        private double mechanicalDingPhase3 = 0;
        private double mechanicalDingPhase4 = 0;
        private double mechanicalDiTime = -1;
        private double mechanicalDiPhase1 = 0;
        private double mechanicalDiPhase2 = 0;
        private double mechanicalDiCurrentLevel = 0;
        private double mechanicalSpecialTime = -1;
        private double mechanicalSpecialPhase = 0;
        private double mechanicalSpecialBodyTime = -1;
        private double mechanicalSpecialBodyPhase = 0;

        private double kickBodyLevel = 0;
        private double kickClickLevel = 0;
        private double kickClickFrequency = 0;
        private double kickPresenceLevel = 0;
        private double kickPresenceFrequency = 0;
        private double downbeatTomLevel = 0;
        private double downbeatTomFrequency = 0;
        private double snareToneLevel = 0;
        private double snareNoiseLevel = 0;
        private double snareNoiseFrequency = 0;
        private double hatLevel = 0;
        private double hatFrequency = 0;
        private double mechanicalDingLevel = 0;
        private double mechanicalDingFrequency = 1600;
        private double mechanicalDingNoiseLevel = 0;
        private double mechanicalDiLevel = 0;
        private double mechanicalDiFrequency = 1100;
        private double mechanicalDiNoiseLevel = 0;
        private double mechanicalDiNoiseFrequency = 2400;
        private double mechanicalSpecialLevel = 0;
        private double mechanicalSpecialFrequency = 1180;
        private double mechanicalSpecialBodyFrequency = 720;
        private double mechanicalSpecialNoiseLevel = 0;
        private double mechanicalSpecialNoiseFrequency = 3600;
        private double highFrequencyGain = 1;
        private double outputGain = 1;
        private String toneId = TONE_MECHANICAL;
        private boolean mechanicalTone = TONE_MECHANICAL.equals(toneId);

        DrumSynth(double sampleRate) {
            this.sampleRate = sampleRate;
            this.inverseSampleRate = 1.0 / sampleRate;
            this.twoPiOverSampleRate = TWO_PI * inverseSampleRate;
            configure(5.0f, 1.0f, 1.5f, 1.5f, 1.0f);
        }

        void setTone(String nextToneId) {
            String normalized = normalizeToneId(nextToneId);
            boolean nextMechanicalTone = TONE_MECHANICAL.equals(normalized);
            if (normalized.equals(toneId) && mechanicalTone == nextMechanicalTone) {
                return;
            }
            toneId = normalized;
            mechanicalTone = nextMechanicalTone;
            kickBodyTime = -1;
            kickClickTime = -1;
            kickPresenceTime = -1;
            tomTime = -1;
            snareToneTime = -1;
            snareNoiseTime = -1;
            hatTime = -1;
            mechanicalDingTime = -1;
            mechanicalDiTime = -1;
            mechanicalSpecialTime = -1;
            mechanicalSpecialBodyTime = -1;
        }

        void configure(
            float volume,
            float brightness,
            float firstBeatLevel,
            float specialBeatLevel,
            float otherBeatLevel
        ) {
            double firstBeatDrive = volume * firstBeatLevel;
            double specialBeatDrive = volume * specialBeatLevel;
            double otherBeatDrive = volume * otherBeatLevel;
            double highShelfGainDb = (brightness - 1.0) * 8.0;
            outputGain = 1.0 + Math.max(0, volume - 5.0) * 0.2;

            kickBodyLevel = 0.85 * firstBeatDrive;
            kickClickLevel = 0.05 * firstBeatDrive * (0.8 + brightness * 0.3);
            kickClickFrequency = 900 + brightness * 600;
            kickPresenceLevel = 0.03 * firstBeatDrive * (0.8 + brightness * 0.3);
            kickPresenceFrequency = 3500 + brightness * 800;
            downbeatTomLevel = 0.55 * firstBeatDrive;
            downbeatTomFrequency = 105 + brightness * 10;
            snareToneLevel = 0.45 * specialBeatDrive;
            snareNoiseLevel = 0.32 * specialBeatDrive;
            snareNoiseFrequency = 1400 + brightness * 800;
            hatLevel = 0.18 * otherBeatDrive;
            hatFrequency = 5000 + brightness * 1200;
            mechanicalDingLevel = 0.46 * firstBeatDrive * (0.88 + brightness * 0.12);
            mechanicalDingFrequency = 2350 + brightness * 400;
            mechanicalDingNoiseLevel = 0.055 * firstBeatDrive * (0.8 + brightness * 0.2);
            mechanicalDiLevel = 0.30 * otherBeatDrive;
            mechanicalDiFrequency = 1550 + brightness * 260;
            mechanicalDiNoiseLevel = 0.12 * otherBeatDrive * (0.8 + brightness * 0.2);
            mechanicalDiNoiseFrequency = 5200 + brightness * 900;
            mechanicalSpecialLevel = 0.36 * specialBeatDrive;
            mechanicalSpecialFrequency = 1180 + brightness * 200;
            mechanicalSpecialBodyFrequency = 720 + brightness * 120;
            mechanicalSpecialNoiseLevel = 0.1 * specialBeatDrive * (0.8 + brightness * 0.2);
            mechanicalSpecialNoiseFrequency = 3600 + brightness * 900;
            highFrequencyGain = Math.pow(10, highShelfGainDb / 20.0);
        }

        void trigger(int accentLevel) {
            trigger(accentLevel, false);
        }

        void trigger(int accentLevel, boolean sixEightSpecialBeat) {
            if (TONE_MECHANICAL.equals(toneId)) {
                if (accentLevel == 2) {
                    triggerMechanicalDing();
                } else if (sixEightSpecialBeat) {
                    triggerMechanicalSpecial();
                } else {
                    triggerMechanicalDi();
                }
                return;
            }

            if (accentLevel == 2) {
                kickBodyTime = 0;
                kickBodyPhase = 0;
                kickClickTime = 0;
                kickClickPhase = 0;
                kickPresenceTime = 0;
                kickPresenceFilter.previousInput = 0;
                kickPresenceFilter.previousOutput = 0;
                tomTime = 0;
                tomPhase = 0;
            } else if (accentLevel == 1) {
                snareToneTime = 0;
                snareTonePhase = 0;
                snareNoiseTime = 0;
                snareNoiseFilter.previousInput = 0;
                snareNoiseFilter.previousOutput = 0;
            } else {
                hatTime = 0;
                hatFilter.previousInput = 0;
                hatFilter.previousOutput = 0;
            }
        }

        private void triggerMechanicalDing() {
            mechanicalDingTime = 0;
            mechanicalDingPhase1 = 0;
            mechanicalDingPhase2 = 0;
            mechanicalDingPhase3 = 0;
            mechanicalDingPhase4 = 0;
            resetMechanicalNoiseFilter();
        }

        private void triggerMechanicalDi() {
            mechanicalDiTime = 0;
            mechanicalDiPhase1 = 0;
            mechanicalDiPhase2 = 0;
            mechanicalDiCurrentLevel = mechanicalDiLevel;
            resetMechanicalNoiseFilter();
        }

        private void triggerMechanicalSpecial() {
            mechanicalSpecialTime = 0;
            mechanicalSpecialPhase = 0;
            mechanicalSpecialBodyTime = -1;
            mechanicalSpecialBodyPhase = 0;
            resetMechanicalNoiseFilter();
        }

        private void resetMechanicalNoiseFilter() {
            mechanicalNoiseFilter.previousInput = 0;
            mechanicalNoiseFilter.previousOutput = 0;
        }

        float nextSample() {
            if (mechanicalTone) {
                return nextMechanicalSample();
            }

            double sample = 0;

            if (kickBodyTime >= 0) {
                double frequency = exponentialFrequency(180, 50, kickBodyTime, 0.08);
                kickBodyPhase += frequency * twoPiOverSampleRate;
                sample += Math.sin(kickBodyPhase) * envelope(kickBodyTime, kickBodyLevel, 0.0008, 0.24);
                kickBodyTime += inverseSampleRate;
                if (kickBodyTime > 0.242) {
                    kickBodyTime = -1;
                }
            }

            if (kickClickTime >= 0) {
                double square = (kickClickPhase % 1) < 0.5 ? 1 : -1;
                sample += square * envelope(kickClickTime, kickClickLevel, 0.0004, 0.012) * highFrequencyGain;
                kickClickPhase += kickClickFrequency * inverseSampleRate;
                kickClickTime += inverseSampleRate;
                if (kickClickTime > 0.014) {
                    kickClickTime = -1;
                }
            }

            if (kickPresenceTime >= 0) {
                double noise = random.nextDouble() * 2 - 1;
                double filtered = highPass(noise, kickPresenceFrequency, kickPresenceFilter);
                sample += filtered * envelope(kickPresenceTime, kickPresenceLevel, 0.0008, 0.03) * highFrequencyGain;
                kickPresenceTime += inverseSampleRate;
                if (kickPresenceTime > 0.032) {
                    kickPresenceTime = -1;
                }
            }

            if (tomTime >= 0) {
                double frequency = exponentialFrequency(
                    downbeatTomFrequency,
                    downbeatTomFrequency * 0.7,
                    tomTime,
                    0.16
                );
                tomPhase += frequency * twoPiOverSampleRate;
                double triangle = (2 / Math.PI) * Math.asin(Math.sin(tomPhase));
                sample += triangle * envelope(tomTime, downbeatTomLevel, 0.001, 0.28);
                tomTime += inverseSampleRate;
                if (tomTime > 0.282) {
                    tomTime = -1;
                }
            }

            if (snareToneTime >= 0) {
                double frequency = exponentialFrequency(260, 170, snareToneTime, 0.045);
                snareTonePhase += frequency * twoPiOverSampleRate;
                double triangle = (2 / Math.PI) * Math.asin(Math.sin(snareTonePhase));
                sample += triangle * envelope(snareToneTime, snareToneLevel, 0.0008, 0.09);
                snareToneTime += inverseSampleRate;
                if (snareToneTime > 0.092) {
                    snareToneTime = -1;
                }
            }

            if (snareNoiseTime >= 0) {
                double noise = random.nextDouble() * 2 - 1;
                double filtered = highPass(noise, snareNoiseFrequency, snareNoiseFilter);
                sample += filtered * envelope(snareNoiseTime, snareNoiseLevel, 0.0008, 0.16) * highFrequencyGain;
                snareNoiseTime += inverseSampleRate;
                if (snareNoiseTime > 0.162) {
                    snareNoiseTime = -1;
                }
            }

            if (hatTime >= 0) {
                double noise = random.nextDouble() * 2 - 1;
                double filtered = highPass(noise, hatFrequency, hatFilter);
                sample += filtered * envelope(hatTime, hatLevel, 0.0008, 0.1) * highFrequencyGain;
                hatTime += inverseSampleRate;
                if (hatTime > 0.102) {
                    hatTime = -1;
                }
            }

            return (float) processOutput(sample);
        }

        private float nextMechanicalSample() {
            double sample = 0;
            double deltaTime = inverseSampleRate;

            if (mechanicalDingTime >= 0) {
                double baseFrequency = mechanicalDingFrequency;
                mechanicalDingPhase1 += twoPiOverSampleRate * baseFrequency;
                mechanicalDingPhase2 += twoPiOverSampleRate * baseFrequency * 2.01;
                mechanicalDingPhase3 += twoPiOverSampleRate * baseFrequency * 3.02;
                mechanicalDingPhase4 += twoPiOverSampleRate * baseFrequency * 4.18;

                double fundamentalEnvelope = envelope(
                    mechanicalDingTime,
                    mechanicalDingLevel,
                    0.00008,
                    MECHANICAL_DING_DURATION * 0.78
                );
                double harmonicEnvelope = envelope(
                    mechanicalDingTime,
                    mechanicalDingLevel,
                    0.00005,
                    MECHANICAL_DING_DURATION * 0.48
                );
                double ringModulation = 1 + Math.sin(TWO_PI * 8.5 * mechanicalDingTime) * 0.025;
                sample += Math.sin(mechanicalDingPhase1) * fundamentalEnvelope * 0.48 * ringModulation;
                sample += Math.sin(mechanicalDingPhase2) * harmonicEnvelope * 0.25;
                sample += Math.sin(mechanicalDingPhase3) * harmonicEnvelope * 0.16;
                sample += Math.sin(mechanicalDingPhase4) * harmonicEnvelope * 0.10;

                double noise = random.nextDouble() * 2 - 1;
                double filtered = highPass(
                    noise,
                    7000 + brightnessFrequencyOffset(),
                    mechanicalNoiseFilter
                );
                sample += filtered
                    * envelope(mechanicalDingTime, mechanicalDingNoiseLevel, 0.0001, 0.007)
                    * highFrequencyGain;

                mechanicalDingTime += deltaTime;
                if (mechanicalDingTime > MECHANICAL_DING_DURATION) {
                    mechanicalDingTime = -1;
                }
            }

            if (mechanicalDiTime >= 0) {
                double strikeFrequency = exponentialFrequency(
                    mechanicalDiFrequency * 1.65,
                    mechanicalDiFrequency * 0.86,
                    mechanicalDiTime,
                    0.009
                );
                mechanicalDiPhase1 += twoPiOverSampleRate * strikeFrequency;
                mechanicalDiPhase2 += twoPiOverSampleRate * mechanicalDiFrequency * 2.08;
                sample += Math.sin(mechanicalDiPhase1)
                    * envelope(mechanicalDiTime, mechanicalDiCurrentLevel * 0.72, 0.00008, 0.019)
                    * 0.78;
                sample += Math.sin(mechanicalDiPhase2)
                    * envelope(mechanicalDiTime, mechanicalDiCurrentLevel * 0.22, 0.00005, 0.011)
                    * 0.28;

                double noise = random.nextDouble() * 2 - 1;
                double filtered = highPass(noise, mechanicalDiNoiseFrequency, mechanicalNoiseFilter);
                sample += filtered
                    * envelope(mechanicalDiTime, mechanicalDiCurrentLevel * 0.14, 0.00006, 0.005)
                    * highFrequencyGain;

                mechanicalDiTime += deltaTime;
                if (mechanicalDiTime > MECHANICAL_DI_DURATION) {
                    mechanicalDiTime = -1;
                }
            }

            if (mechanicalSpecialTime >= 0) {
                double strikeFrequency = exponentialFrequency(
                    mechanicalSpecialFrequency * 1.9,
                    mechanicalSpecialFrequency * 0.82,
                    mechanicalSpecialTime,
                    0.011
                );
                mechanicalSpecialPhase += twoPiOverSampleRate * strikeFrequency;
                sample += Math.sin(mechanicalSpecialPhase)
                    * envelope(mechanicalSpecialTime, mechanicalSpecialLevel * 0.9, 0.0001, 0.011)
                    * 0.72;

                double noise = random.nextDouble() * 2 - 1;
                double filtered = highPass(
                    noise,
                    mechanicalSpecialNoiseFrequency + 520,
                    mechanicalNoiseFilter
                );
                sample += filtered
                    * envelope(mechanicalSpecialTime, mechanicalSpecialLevel * 0.22, 0.0001, 0.006)
                    * highFrequencyGain;

                if (mechanicalSpecialTime >= 0.007 && mechanicalSpecialBodyTime < 0) {
                    mechanicalSpecialBodyTime = 0;
                    mechanicalSpecialBodyPhase = 0;
                }

                mechanicalSpecialTime += deltaTime;
                if (mechanicalSpecialTime > MECHANICAL_SPECIAL_DURATION) {
                    mechanicalSpecialTime = -1;
                }
            }

            if (mechanicalSpecialBodyTime >= 0) {
                mechanicalSpecialBodyPhase += twoPiOverSampleRate * mechanicalSpecialBodyFrequency * 0.82;
                sample += Math.sin(mechanicalSpecialBodyPhase)
                    * envelope(mechanicalSpecialBodyTime, mechanicalSpecialLevel, 0.00025, 0.033)
                    * 0.5;

                double noise = random.nextDouble() * 2 - 1;
                double filtered = highPass(noise, 1450, mechanicalNoiseFilter);
                sample += filtered
                    * envelope(mechanicalSpecialBodyTime, mechanicalSpecialLevel * 0.2, 0.00018, 0.014)
                    * highFrequencyGain;

                mechanicalSpecialBodyTime += deltaTime;
                if (mechanicalSpecialBodyTime > 0.035) {
                    mechanicalSpecialBodyTime = -1;
                }
            }

            return (float) processOutput(sample);
        }

        private double brightnessFrequencyOffset() {
            return Math.max(0, mechanicalDingFrequency - 2050) * 2.0;
        }
        private double envelope(double time, double peak, double attack, double duration) {
            if (time < 0 || time > duration || peak <= 0) {
                return 0;
            }
            double attackGain = attack <= 0 ? 1 : Math.min(1, time / attack);
            double endRatio = Math.max(0.000001, 0.0001 / peak);
            double tau = duration / Math.log(1 / endRatio);
            return peak * attackGain * Math.exp(-time / tau);
        }

        private double exponentialFrequency(double start, double end, double time, double duration) {
            double progress = Math.max(0, Math.min(1, time / duration));
            return start * Math.pow(end / start, progress);
        }

        private double highPass(double input, double cutoff, FilterState state) {
            double safeCutoff = Math.max(20, cutoff);
            double rc = 1 / (TWO_PI * safeCutoff);
            double dt = 1 / sampleRate;
            double alpha = rc / (rc + dt);
            double output = alpha * (state.previousOutput + input - state.previousInput);
            state.previousInput = input;
            state.previousOutput = output;
            return output;
        }

        private double processOutput(double input) {
            double compressed = compress(input * 0.95) * outputGain;
            return limit(compressed);
        }

        private double compress(double input) {
            double magnitude = Math.abs(input);
            if (magnitude <= COMPRESSOR_THRESHOLD) {
                return input;
            }
            double inputDb = 20 * Math.log10(magnitude);
            double outputDb = -4 + ((inputDb + 4) / 8);
            double outputMagnitude = Math.pow(10, outputDb / 20);
            return input < 0 ? -outputMagnitude : outputMagnitude;
        }

        private double limit(double input) {
            double magnitude = Math.abs(input);
            if (magnitude <= LIMITER_THRESHOLD) {
                return input;
            }
            double normalized = Math.min(1, (magnitude - LIMITER_THRESHOLD) / (1 - LIMITER_THRESHOLD));
            double limited = LIMITER_THRESHOLD
                + (LIMITER_CEILING - LIMITER_THRESHOLD)
                * (Math.tanh(normalized * 2) / LIMITER_NORMALIZATION);
            return input < 0 ? -limited : limited;
        }
    }
}
