package com.gymburn.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.Map;

/**
 * Serviço em primeiro plano: segura o Bluetooth e o servidor HTTP local mesmo
 * com a tela apagada e mesmo quando o GymBurn é reinstalado.
 */
public final class BridgeService extends Service {

    public static final int PORT = 8765;
    private static final String CHANNEL_ID = "gymburn-bridge";
    private static final int NOTIFICATION_ID = 1001;

    private static volatile BridgeService instance;

    private final Handler main = new Handler(Looper.getMainLooper());

    private BleCentral ble;
    private BridgeHttpServer server;
    private Runnable notificationTick;

    public static BleCentral central() {
        BridgeService local = instance;
        return local == null ? null : local.ble;
    }

    public static boolean isRunning() {
        return instance != null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannel();
        startForeground(NOTIFICATION_ID, buildNotification("Iniciando…"));
        ble = new BleCentral(this);
        server = new BridgeHttpServer(PORT, this::handle);
        try {
            server.start();
        } catch (IOException error) {
            EventBus.log("Falha ao abrir HTTP local: " + error.getMessage());
        }
        // Retoma a última esteira sem precisar do app: o link nunca fica órfão entre builds.
        ble.resume();
        notificationTick = () -> {
            updateNotification();
            main.postDelayed(notificationTick, 2500);
        };
        main.postDelayed(notificationTick, 2500);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (server != null) {
            server.stop();
        }
        if (ble != null) {
            ble.disconnect();
        }
        instance = null;
        super.onDestroy();
    }

    private JSONObject handle(String method, String path, Map<String, String> query, JSONObject body) throws Exception {
        switch (path) {
            case "/ping":
                return simple(true);
            case "/status":
                return ble.status();
            case "/events": {
                long after = 0;
                String raw = query.get("after");
                if (raw != null) {
                    try {
                        after = Long.parseLong(raw);
                    } catch (NumberFormatException ignored) {
                    }
                }
                JSONObject out = new JSONObject();
                out.put("events", ble.events(after));
                out.put("lastSeq", EventBus.lastSeq());
                return out;
            }
            case "/scan/start":
                ble.startScan();
                return simple(true);
            case "/scan/stop":
                ble.stopScan();
                return simple(true);
            case "/connect":
                ble.connect(body.optString("id", "").trim());
                return ble.status();
            case "/disconnect":
                ble.disconnect();
                return simple(true);
            case "/forget":
                ble.forget();
                return simple(true);
            case "/services":
                return ble.services();
            case "/read":
                return ble.read(body.getString("service"), body.getString("char"));
            case "/write":
                return ble.write(
                        body.getString("service"),
                        body.getString("char"),
                        BleCentral.unhex(body.optString("data", "")),
                        body.optBoolean("response", true));
            case "/subscribe":
                return ble.subscribe(
                        body.getString("service"),
                        body.getString("char"),
                        body.optBoolean("notify", true));
            default:
                throw new IllegalArgumentException("Rota desconhecida: " + path);
        }
    }

    private static JSONObject simple(boolean ok) throws JSONException {
        JSONObject out = new JSONObject();
        out.put("ok", ok);
        return out;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Ponte da esteira",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Mantém a conexão BLE com a esteira viva entre builds do GymBurn");
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("Ponte GymBurn")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true)
                .build();
    }

    private void updateNotification() {
        BleCentral local = ble;
        if (local == null) {
            return;
        }
        String text;
        try {
            JSONObject status = local.status();
            if (status.optBoolean("connected")) {
                String name = status.optString("name", "");
                String device = status.optString("deviceId", "");
                text = "Esteira conectada · " + (name == null || name.isEmpty() ? device : name + " · " + device);
            } else if (status.optBoolean("scanning")) {
                text = "Procurando esteiras…";
            } else {
                text = "Aguardando conexão com a esteira";
            }
        } catch (JSONException error) {
            text = "Ativa";
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification(text));
        }
    }
}
