package com.gymburn.bridge;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Job periódico (sobrevive a reboot): garante a ponte de pé mesmo sem alarme. */
public final class WatchdogJobService extends JobService {

    public static final int JOB_ID = 4242;

    @Override
    public boolean onStartJob(JobParameters params) {
        BridgeWatchdog.ensureService(this);
        BridgeWatchdog.schedule(this);
        jobFinished(params, false);
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
