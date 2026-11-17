package com.gymburn.bridge;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

/**
 * Atalho sem interface para o GymBurn acordar a ponte sozinho
 * (`gymburn-bridge://start`). Fecha antes de aparecer de verdade.
 */
public final class StartActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent service = new Intent(this, BridgeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
        BridgeWatchdog.schedule(this);
        finish();
        overridePendingTransition(0, 0);
    }
}
