package com.gymburn.bridge;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Dono do link BLE. Vive no processo da ponte, que é um app separado: quando o
 * GymBurn é reinstalado, este processo continua rodando e a esteira nunca cai.
 *
 * Fala GATT genérico (descobre serviços, lê, escreve e assina notificações) —
 * o protocolo da Matrix fica no GymBurn. O endereço da última esteira fica
 * salvo e a reconexão é automática.
 */
public final class BleCentral {

    private static final String TAG = "GymBurnBridge";
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final int MAX_SCAN_EVENTS_PER_DEVICE_MS = 700;

    private final Context context;
    private final BluetoothAdapter adapter;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());

    private final Map<String, CountDownLatch> writeLatches = new ConcurrentHashMap<>();
    private final Map<String, Integer> writeResults = new ConcurrentHashMap<>();
    private final Map<String, CountDownLatch> readLatches = new ConcurrentHashMap<>();
    private final Map<String, byte[]> readValues = new ConcurrentHashMap<>();
    private final Map<String, Long> lastScanEmit = new ConcurrentHashMap<>();
    /** Último anúncio de cada endereço: o app reusa o link sem depender de o aparelho anunciar. */
    private final Map<String, JSONObject> lastAdverts = new ConcurrentHashMap<>();
    private final Set<String> subscribed = ConcurrentHashMap.newKeySet();

    private final Object gattLock = new Object();

    private volatile BluetoothGatt gatt;
    private volatile BluetoothLeScanner scanner;
    private volatile boolean scanning;
    private volatile boolean connected;
    private volatile boolean servicesReady;
    private volatile boolean persistent = true;
    private volatile boolean manualDisconnect;
    private volatile String address;
    private volatile String deviceName;
    private volatile int lastRssi;
    private volatile int reconnectAttempts;

    private String lastKnownAddress;

    public BleCentral(Context context) {
        this.context = context.getApplicationContext();
        BluetoothManager manager = (BluetoothManager) this.context.getSystemService(Context.BLUETOOTH_SERVICE);
        this.adapter = manager == null ? null : manager.getAdapter();
        this.prefs = this.context.getSharedPreferences("gymburn-bridge", Context.MODE_PRIVATE);
        this.lastKnownAddress = prefs.getString("lastAddress", null);
    }

    // ---------------------------------------------------------------- estado

    public JSONObject status() throws JSONException {
        JSONObject out = new JSONObject();
        boolean enabled;
        try {
            enabled = adapter != null && adapter.isEnabled();
        } catch (SecurityException error) {
            enabled = false;
        }
        out.put("ok", true);
        out.put("connected", connected);
        out.put("servicesReady", servicesReady);
        out.put("scanning", scanning);
        out.put("deviceId", address);
        out.put("name", deviceName);
        out.put("rssi", lastRssi);
        out.put("persistent", persistent);
        out.put("autoAddress", lastKnownAddress);
        out.put("bluetoothEnabled", enabled);
        out.put("lastSeq", EventBus.lastSeq());
        out.put("subscribed", new JSONArray(subscribed));
        out.put("missingPermissions", missingPermissions());
        return out;
    }

    public JSONArray events(long after) {
        return EventBus.since(after);
    }

    public boolean isConnected() {
        return connected;
    }

    public String getAddress() {
        return address;
    }

    // ---------------------------------------------------------------- busca

    public synchronized void startScan() throws JSONException {
        checkScanner();
        if (scanning) {
            return;
        }
        BluetoothLeScanner local = adapter.getBluetoothLeScanner();
        if (local == null) {
            throw new IllegalStateException("Scanner BLE indisponível (Bluetooth desligado?)");
        }
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setReportDelay(0)
                .build();
        scanner = local;
        lastScanEmit.clear();
        scanning = true;
        local.startScan(null, settings, scanCallback);
        EventBus.emit("scanStarted", new JSONObject());
        // A esteira conectada costuma parar de anunciar. Reemite o último anúncio dela
        // para o GymBurn achá-la na busca e retomar o link sem tocar no painel.
        emitCachedAdvertisement();
    }

    public synchronized void stopScan() {
        scanning = false;
        BluetoothLeScanner local = scanner;
        scanner = null;
        if (local != null) {
            try {
                local.stopScan(scanCallback);
            } catch (SecurityException ignored) {
            }
        }
        JSONObject fields = new JSONObject();
        EventBus.emit("scanStopped", fields);
    }

    private void checkScanner() {
        if (adapter == null) {
            throw new IllegalStateException("Bluetooth não suportado");
        }
        boolean enabled;
        try {
            enabled = adapter.isEnabled();
        } catch (SecurityException error) {
            throw new IllegalStateException("Sem permissão para ler o Bluetooth (BLUETOOTH_CONNECT)");
        }
        if (!enabled) {
            throw new IllegalStateException("Bluetooth desligado");
        }
        String permission = Build.VERSION.SDK_INT >= 31
                ? Manifest.permission.BLUETOOTH_SCAN
                : Manifest.permission.ACCESS_FINE_LOCATION;
        if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            throw new IllegalStateException("Permissão de busca do Bluetooth negada");
        }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            emitScanResult(result);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult result : results) {
                emitScanResult(result);
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanning = false;
            JSONObject fields = new JSONObject();
            try {
                fields.put("errorCode", errorCode);
            } catch (JSONException ignored) {
            }
            EventBus.emit("scanFailed", fields);
        }
    };

    private void emitCachedAdvertisement() {
        String current = address;
        if (!connected || current == null) {
            return;
        }
        JSONObject cached = lastAdverts.get(current);
        if (cached == null) {
            return;
        }
        try {
            JSONObject copy = new JSONObject(cached.toString());
            copy.put("cached", true);
            EventBus.emit("scan", copy);
        } catch (JSONException ignored) {
        }
    }

    private void emitScanResult(ScanResult result) {
        if (result == null || result.getDevice() == null) {
            return;
        }
        BluetoothDevice device = result.getDevice();
        String deviceAddress;
        try {
            deviceAddress = device.getAddress();
        } catch (SecurityException error) {
            return;
        }
        long now = System.currentTimeMillis();
        Long previous = lastScanEmit.get(deviceAddress);
        if (previous != null && now - previous < MAX_SCAN_EVENTS_PER_DEVICE_MS) {
            return;
        }
        lastScanEmit.put(deviceAddress, now);

        JSONObject fields = new JSONObject();
        try {
            fields.put("id", deviceAddress);
            fields.put("name", deviceNameOf(device));
            fields.put("rssi", result.getRssi());
            fields.put("connectable", result.isConnectable());
            ScanRecord record = result.getScanRecord();
            if (record != null) {
                JSONArray serviceUuids = new JSONArray();
                List<android.os.ParcelUuid> uuids = record.getServiceUuids();
                if (uuids != null) {
                    for (android.os.ParcelUuid parcel : uuids) {
                        serviceUuids.put(shortUuid(parcel.getUuid().toString()));
                    }
                }
                fields.put("serviceUuids", serviceUuids);

                JSONObject serviceData = new JSONObject();
                Map<android.os.ParcelUuid, byte[]> data = record.getServiceData();
                if (data != null) {
                    for (Map.Entry<android.os.ParcelUuid, byte[]> entry : data.entrySet()) {
                        serviceData.put(shortUuid(entry.getKey().getUuid().toString()), hex(entry.getValue()));
                    }
                }
                fields.put("serviceData", serviceData);

                JSONObject manufacturerData = new JSONObject();
                Map<Integer, byte[]> makers = parseManufacturer(record);
                if (makers != null) {
                    for (Map.Entry<Integer, byte[]> entry : makers.entrySet()) {
                        manufacturerData.put(String.valueOf(entry.getKey()), hex(entry.getValue()));
                    }
                }
                fields.put("manufacturerData", manufacturerData);
                fields.put("txPower", record.getTxPowerLevel());
            }
        } catch (JSONException ignored) {
        }
        try {
            lastAdverts.put(deviceAddress, new JSONObject(fields.toString()));
        } catch (JSONException ignored) {
        }
        EventBus.emit("scan", fields);
    }

    /** Reconstrução do mapa de fabricante (a API entrega um SparseArray). */
    private static Map<Integer, byte[]> parseManufacturer(ScanRecord record) {
        Map<Integer, byte[]> out = new LinkedHashMap<>();
        try {
            android.util.SparseArray<byte[]> sparse = record.getManufacturerSpecificData();
            if (sparse != null) {
                for (int index = 0; index < sparse.size(); index++) {
                    out.put(sparse.keyAt(index), sparse.valueAt(index));
                }
            }
        } catch (RuntimeException ignored) {
        }
        return out;
    }

    private static String deviceNameOf(BluetoothDevice device) {
        try {
            return device.getName();
        } catch (SecurityException error) {
            return null;
        } catch (RuntimeException error) {
            return null;
        }
    }

    // ---------------------------------------------------------------- conexão

    /** Conecta e mantém o link: usado pelo app e pela reconexão automática. */
    public synchronized void connect(String deviceAddress) throws JSONException {
        if (deviceAddress == null || deviceAddress.isEmpty()) {
            throw new IllegalArgumentException("Endereço vazio");
        }
        checkScanner();
        stopScan();
        closeGatt();
        manualDisconnect = false;
        persistent = true;
        reconnectAttempts = 0;
        servicesReady = false;
        address = deviceAddress;
        lastKnownAddress = deviceAddress;
        prefs.edit().putString("lastAddress", deviceAddress).apply();
        EventBus.emit("connecting", field("id", deviceAddress));
        openGatt(deviceAddress);
    }

    private void openGatt(String deviceAddress) {
        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(deviceAddress);
        } catch (IllegalArgumentException error) {
            EventBus.emit("error", field("message", "Endereço BLE inválido: " + deviceAddress));
            return;
        } catch (SecurityException error) {
            EventBus.emit("error", field("message", "Sem permissão BLUETOOTH_CONNECT"));
            return;
        }
        BluetoothGatt created;
        try {
            created = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException error) {
            EventBus.emit("error", field("message", "Sem permissão para conectar: " + error.getMessage()));
            return;
        }
        gatt = created;
        if (created == null) {
            EventBus.emit("error", field("message", "connectGatt devolveu null"));
        }
    }

    public synchronized void disconnect() {
        manualDisconnect = true;
        persistent = false;
        stopScan();
        closeGatt();
        connected = false;
        servicesReady = false;
        subscribed.clear();
        EventBus.emit("disconnected", field("reason", "user"));
    }

    /** Esquece a esteira salva (não reconecta sozinha depois). */
    public synchronized void forget() {
        disconnect();
        lastKnownAddress = null;
        address = null;
        prefs.edit().remove("lastAddress").apply();
    }

    /** Chamado quando o serviço sobe: retoma a última esteira sem passar pelo app. */
    public synchronized void resume() {
        if (lastKnownAddress == null || connected) {
            return;
        }
        persistent = true;
        manualDisconnect = false;
        address = lastKnownAddress;
        EventBus.emit("resuming", field("id", lastKnownAddress));
        openGatt(lastKnownAddress);
    }

    private void closeGatt() {
        BluetoothGatt local = gatt;
        gatt = null;
        connected = false;
        if (local != null) {
            try {
                local.disconnect();
            } catch (RuntimeException ignored) {
            }
            try {
                local.close();
            } catch (RuntimeException ignored) {
            }
        }
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                connected = true;
                reconnectAttempts = 0;
                EventBus.emit("connected", field("id", describeAddress(gatt)));
                try {
                    gatt.discoverServices();
                } catch (SecurityException error) {
                    EventBus.emit("error", field("message", "Sem permissão para descobrir serviços"));
                }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                connected = false;
                servicesReady = false;
                subscribed.clear();
                EventBus.emit("disconnected", fields2("id", describeAddress(gatt), "status", status));
                closeGatt();
                scheduleReconnect();
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            servicesReady = status == BluetoothGatt.GATT_SUCCESS;
            EventBus.emit("services", fields2("ok", servicesReady, "status", status));
        }

        // Android 13+ (targetSdk 33+) entrega o valor por parâmetro e não chama mais o
        // overload antigo. Os dois ficam ligados para funcionar em qualquer versão.
        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            emitNotification(characteristic, characteristic.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            emitNotification(characteristic, value);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            resolveRead(characteristic, characteristic.getValue(), status);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value, int status) {
            resolveRead(characteristic, value, status);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            String key = characteristic.getUuid().toString().toLowerCase(Locale.US);
            writeResults.put(key, status);
            CountDownLatch latch = writeLatches.remove(key);
            if (latch != null) {
                latch.countDown();
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            EventBus.emit("descriptorWrite", fields2("uuid", shortUuid(descriptor.getUuid().toString()), "status", status));
        }
    };

    private void emitNotification(BluetoothGattCharacteristic characteristic, byte[] value) {
        JSONObject fields = new JSONObject();
        try {
            fields.put("service", shortUuid(characteristic.getService().getUuid().toString()));
            fields.put("char", shortUuid(characteristic.getUuid().toString()));
            fields.put("data", hex(value));
            fields.put("atDevice", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        EventBus.emit("notify", fields);
    }

    private void resolveRead(BluetoothGattCharacteristic characteristic, byte[] value, int status) {
        String key = characteristic.getUuid().toString().toLowerCase(Locale.US);
        if (status == BluetoothGatt.GATT_SUCCESS && value != null) {
            readValues.put(key, value.clone());
        }
        CountDownLatch latch = readLatches.remove(key);
        if (latch != null) {
            latch.countDown();
        }
    }

    private void scheduleReconnect() {
        if (manualDisconnect || !persistent || address == null) {
            return;
        }
        reconnectAttempts += 1;
        long delay = Math.min(800L * reconnectAttempts, 8000L);
        final String target = address;
        EventBus.emit("reconnecting", fields2("id", target, "inMs", delay));
        main.postDelayed(() -> {
            if (manualDisconnect || !persistent || connected) {
                return;
            }
            EventBus.emit("reconnectAttempt", field("id", target));
            openGatt(target);
        }, delay);
    }

    // ---------------------------------------------------------------- GATT

    public JSONObject services() throws JSONException {
        BluetoothGatt local = requireGatt();
        JSONArray list = new JSONArray();
        List<BluetoothGattService> found = local.getServices();
        if (found != null) {
            for (BluetoothGattService service : found) {
                JSONObject item = new JSONObject();
                item.put("uuid", shortUuid(service.getUuid().toString()));
                JSONArray characteristics = new JSONArray();
                for (BluetoothGattCharacteristic characteristic : service.getCharacteristics()) {
                    JSONObject entry = new JSONObject();
                    entry.put("uuid", shortUuid(characteristic.getUuid().toString()));
                    int properties = characteristic.getProperties();
                    entry.put("read", (properties & BluetoothGattCharacteristic.PROPERTY_READ) != 0);
                    entry.put("write",
                            (properties & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
                                    || (properties & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0);
                    entry.put("writeNoResponse",
                            (properties & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0);
                    entry.put("notify", (properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0);
                    entry.put("indicate", (properties & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0);
                    characteristics.put(entry);
                }
                item.put("characteristics", characteristics);
                list.put(item);
            }
        }
        JSONObject out = new JSONObject();
        out.put("services", list);
        return out;
    }

    public JSONObject read(String serviceUuid, String characteristicUuid) throws Exception {
        BluetoothGatt local = requireGatt();
        BluetoothGattCharacteristic characteristic = find(local, serviceUuid, characteristicUuid);
        String key = characteristic.getUuid().toString().toLowerCase(Locale.US);
        CountDownLatch latch = new CountDownLatch(1);
        readLatches.put(key, latch);
        synchronized (gattLock) {
            if (!local.readCharacteristic(characteristic)) {
                readLatches.remove(key);
                throw new IllegalStateException("readCharacteristic devolveu false");
            }
        }
        if (!latch.await(3, TimeUnit.SECONDS)) {
            readLatches.remove(key);
            throw new IllegalStateException("timeout na leitura");
        }
        byte[] value = readValues.remove(key);
        JSONObject out = new JSONObject();
        out.put("data", value == null ? "" : hex(value));
        return out;
    }

    public JSONObject write(String serviceUuid, String characteristicUuid, byte[] data, boolean withResponse) throws Exception {
        BluetoothGatt local = requireGatt();
        BluetoothGattCharacteristic characteristic = find(local, serviceUuid, characteristicUuid);
        String key = characteristic.getUuid().toString().toLowerCase(Locale.US);
        CountDownLatch latch = new CountDownLatch(1);
        writeLatches.put(key, latch);
        synchronized (gattLock) {
            characteristic.setWriteType(withResponse
                    ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                    : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            characteristic.setValue(data);
            if (!local.writeCharacteristic(characteristic)) {
                writeLatches.remove(key);
                throw new IllegalStateException("writeCharacteristic devolveu false");
            }
        }
        JSONObject out = new JSONObject();
        if (!withResponse) {
            out.put("ok", true);
            out.put("status", 0);
            return out;
        }
        if (!latch.await(3, TimeUnit.SECONDS)) {
            writeLatches.remove(key);
            throw new IllegalStateException("timeout na escrita");
        }
        Integer status = writeResults.remove(key);
        int value = status == null ? -1 : status;
        out.put("status", value);
        if (value != BluetoothGatt.GATT_SUCCESS) {
            throw new IllegalStateException("GATT status=" + value);
        }
        return out;
    }

    public JSONObject subscribe(String serviceUuid, String characteristicUuid, boolean enable) throws Exception {
        BluetoothGatt local = requireGatt();
        BluetoothGattCharacteristic characteristic = find(local, serviceUuid, characteristicUuid);
        boolean ok = local.setCharacteristicNotification(characteristic, enable);
        int properties = characteristic.getProperties();
        boolean indicate = (properties & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
                && (properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0;
        BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CCCD_UUID);
        if (descriptor != null) {
            descriptor.setValue(enable
                    ? (indicate ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                    : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
            synchronized (gattLock) {
                local.writeDescriptor(descriptor);
            }
        }
        String shortName = shortUuid(characteristic.getUuid().toString());
        if (enable) {
            subscribed.add(shortName);
        } else {
            subscribed.remove(shortName);
        }
        JSONObject out = new JSONObject();
        out.put("ok", ok);
        out.put("subscribed", enable);
        out.put("descriptor", descriptor != null);
        return out;
    }

    private BluetoothGatt requireGatt() {
        BluetoothGatt local = gatt;
        if (local == null || !connected) {
            throw new IllegalStateException("Esteira não conectada");
        }
        return local;
    }

    private BluetoothGattCharacteristic find(BluetoothGatt local, String serviceUuid, String characteristicUuid) {
        UUID serviceId = uuidOf(serviceUuid);
        UUID characteristicId = uuidOf(characteristicUuid);
        BluetoothGattService service = local.getService(serviceId);
        if (service == null) {
            throw new IllegalStateException("Serviço não encontrado: " + serviceUuid);
        }
        BluetoothGattCharacteristic characteristic = service.getCharacteristic(characteristicId);
        if (characteristic == null) {
            throw new IllegalStateException("Característica não encontrada: " + characteristicUuid);
        }
        return characteristic;
    }

    // ---------------------------------------------------------------- util

    private JSONArray missingPermissions() {
        JSONArray missing = new JSONArray();
        List<String> needed = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            needed.add(Manifest.permission.BLUETOOTH_SCAN);
            needed.add(Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        for (String permission : needed) {
            if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                missing.put(permission);
            }
        }
        return missing;
    }

    private static String describeAddress(BluetoothGatt gatt) {
        try {
            BluetoothDevice device = gatt.getDevice();
            return device == null ? null : device.getAddress();
        } catch (RuntimeException error) {
            return null;
        }
    }

    private static JSONObject field(String key, Object value) {
        JSONObject fields = new JSONObject();
        try {
            fields.put(key, value);
        } catch (JSONException ignored) {
        }
        return fields;
    }

    private static JSONObject fields2(String key, Object value, String key2, Object value2) {
        JSONObject fields = field(key, value);
        try {
            fields.put(key2, value2);
        } catch (JSONException ignored) {
        }
        return fields;
    }

    public static UUID uuidOf(String text) {
        String value = text.trim().toLowerCase(Locale.US);
        if (value.startsWith("0x")) {
            value = value.substring(2);
        }
        value = value.replace("-", "");
        if (value.length() == 4) {
            value = "0000" + value + "00001000800000805f9b34fb";
        }
        if (value.length() != 32) {
            throw new IllegalArgumentException("UUID inválido: " + text);
        }
        return UUID.fromString(value.substring(0, 8)
                + "-" + value.substring(8, 12)
                + "-" + value.substring(12, 16)
                + "-" + value.substring(16, 20)
                + "-" + value.substring(20));
    }

    public static String shortUuid(String uuid) {
        String lower = uuid.toLowerCase(Locale.US);
        if (lower.startsWith("0000") && lower.endsWith("-0000-1000-8000-00805f9b34fb")) {
            return lower.substring(4, 8);
        }
        return lower;
    }

    public static String hex(byte[] bytes) {
        if (bytes == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(String.format(Locale.US, "%02x", value & 0xff));
        }
        return builder.toString();
    }

    public static byte[] unhex(String text) {
        String clean = text == null ? "" : text.replace(" ", "").replace("-", "");
        if (clean.length() % 2 != 0) {
            throw new IllegalArgumentException("hex com tamanho ímpar");
        }
        byte[] out = new byte[clean.length() / 2];
        for (int index = 0; index < out.length; index++) {
            out[index] = (byte) Integer.parseInt(clean.substring(index * 2, index * 2 + 2), 16);
        }
        return out;
    }

    /** Log curto no ring de eventos, sem depender do logcat. */
    public static void note(String message) {
        EventBus.log(message);
    }

}
