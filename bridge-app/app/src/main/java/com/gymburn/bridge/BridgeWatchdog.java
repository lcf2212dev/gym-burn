package com.gymburn.bridge;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

/**
 * Vigia a ponte: se o sistema (ou o "limpar tudo" do MIUI) matar o processo, um
 * alarme/mini-job traz o serviço de volta sem ninguém abrir o app.
 */
public final class BridgeWatchdog {

    /** Enquanto o serviço está de pé, o alarme só confere — custo desprezível. */
    private static final long ALARM_INTERVAL_MS = 60_000L;

    private BridgeWatchdog() {}

    public static void schedule(Context context) {
        scheduleAlarm(context);
        scheduleJob(context);
    }

    /** Reinício em poucos segundos (usado quando o usuário remove o app dos recentes). */
    public static void ensureSoon(Context context, long delayMs) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            return;
        }
        PendingIntent pending = alarmPending(context);
        manager.setWindow(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + Math.max(0, delayMs),
                1_000L,
                pending);
    }

    static void ensureService(Context context) {
        if (BridgeService.isRunning()) {
            return;
        }
        Intent intent = new Intent(context, BridgeService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException ignored) {
            // Sem permissão para subir em segundo plano agora; o próximo alarme tenta de novo.
        }
    }

    private static void scheduleAlarm(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            return;
        }
        manager.setInexactRepeating(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + ALARM_INTERVAL_MS,
                ALARM_INTERVAL_MS,
                alarmPending(context));
    }

    private static PendingIntent alarmPending(Context context) {
        Intent intent = new Intent(context, WatchdogReceiver.class);
        return PendingIntent.getBroadcast(
                context,
                0,
                intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static void scheduleJob(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) {
            return;
        }
        if (scheduler.getPendingJob(WatchdogJobService.JOB_ID) != null) {
            return;
        }
        JobInfo job = new JobInfo.Builder(
                WatchdogJobService.JOB_ID,
                new ComponentName(context, WatchdogJobService.class))
                .setPeriodic(15 * 60_000L)
                .setPersisted(true)
                .build();
        try {
            scheduler.schedule(job);
        } catch (RuntimeException ignored) {
        }
    }
}
