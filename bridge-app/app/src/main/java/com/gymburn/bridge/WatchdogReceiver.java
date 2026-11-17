package com.gymburn.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Alarme que ressuscita o serviço se o processo tiver sido morto. */
public final class WatchdogReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        BridgeWatchdog.ensureService(context);
        BridgeWatchdog.schedule(context);
    }
}
