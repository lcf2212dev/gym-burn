package com.gymburn.bridge;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Tela mínima: só mostra o estado e liga/desliga a ponte. O trabalho acontece
 * no serviço em primeiro plano, que continua mesmo com esta tela fechada.
 */
public final class MainActivity extends Activity {

    private TextView statusView;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildLayout());
        requestNeededPermissions();
        startBridge();
    }

    @Override
    protected void onResume() {
        super.onResume();
        main.post(updateTick);
    }

    @Override
    protected void onPause() {
        main.removeCallbacks(updateTick);
        super.onPause();
    }

    private ViewGroup buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(48, 96, 48, 48);
        root.setBackgroundColor(Color.parseColor("#0A0F0C"));

        TextView title = new TextView(this);
        title.setText("Ponte GymBurn");
        title.setTextSize(28);
        title.setTextColor(Color.parseColor("#C6FF3D"));
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Mantém a conexão com a esteira viva enquanto o GymBurn é atualizado. Deixe este serviço ativo.");
        subtitle.setTextSize(15);
        subtitle.setTextColor(Color.parseColor("#9BB0A2"));
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setPadding(0, 24, 0, 32);
        root.addView(subtitle);

        statusView = new TextView(this);
        statusView.setTextSize(18);
        statusView.setTextColor(Color.WHITE);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(0, 0, 0, 40);
        root.addView(statusView);

        Button start = new Button(this);
        start.setText("Ativar ponte");
        start.setOnClickListener(view -> startBridge());
        root.addView(start);

        Button stop = new Button(this);
        stop.setText("Desativar ponte");
        stop.setOnClickListener(view -> stopService(new Intent(this, BridgeService.class)));
        root.addView(stop);

        TextView hint = new TextView(this);
        hint.setText("O GymBurn encontra esta ponte sozinho em 127.0.0.1:8765. Se a esteira cair, a ponte reconecta sozinha na última esteira usada.");
        hint.setTextSize(13);
        hint.setTextColor(Color.parseColor("#6E8375"));
        hint.setPadding(0, 32, 0, 0);
        root.addView(hint);

        return root;
    }

    private void startBridge() {
        Intent intent = new Intent(this, BridgeService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
        main.post(updateTick);
    }

    private final Runnable updateTick = new Runnable() {
        @Override
        public void run() {
            statusView.setText(describeStatus());
            main.postDelayed(this, 1000);
        }

        private String describeStatus() {
            BleCentral central = BridgeService.central();
            if (central == null) {
                return "Serviço parado";
            }
            try {
                JSONObject status = central.status();
                StringBuilder text = new StringBuilder();
                text.append("Serviço: ativo\n");
                if (status.optBoolean("connected")) {
                    text.append("Esteira: conectada\n").append(status.optString("deviceId", ""));
                } else if (status.optBoolean("scanning")) {
                    text.append("Esteira: buscando…");
                } else {
                    text.append("Esteira: aguardando");
                }
                JSONArray missing = status.optJSONArray("missingPermissions");
                if (missing != null && missing.length() > 0) {
                    text.append("\nPermissões pendentes: ").append(missing.length());
                }
                return text.toString();
            } catch (Exception error) {
                return "Serviço: ativo (status indisponível)";
            }
        }
    };

    private void requestNeededPermissions() {
        List<String> needed = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            needed.add(Manifest.permission.BLUETOOTH_SCAN);
            needed.add(Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        needed.add(Manifest.permission.POST_NOTIFICATIONS);
        List<String> missing = new ArrayList<>();
        for (String permission : needed) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                missing.add(permission);
            }
        }
        if (!missing.isEmpty()) {
            requestPermissions(missing.toArray(new String[0]), 10);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        startBridge();
    }
}
