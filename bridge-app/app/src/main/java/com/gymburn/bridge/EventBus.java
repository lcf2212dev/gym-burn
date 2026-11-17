package com.gymburn.bridge;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * Fila de eventos que o app GymBurn consome em /events?after=N.
 *
 * Fica na memória do processo da ponte, que continua vivo enquanto o GymBurn é
 * reinstalado — é isso que dá a continuidade do link BLE entre builds.
 */
public final class EventBus {

    private static final int MAX_EVENTS = 4000;

    private static final ArrayDeque<JSONObject> EVENTS = new ArrayDeque<>();
    private static long lastSeq = 0;

    private EventBus() {}

    /** Acrescenta um evento e devolve o seq dele. */
    public static synchronized long emit(String type, JSONObject fields) {
        lastSeq += 1;
        JSONObject event = new JSONObject();
        try {
            event.put("seq", lastSeq);
            event.put("type", type);
            event.put("at", System.currentTimeMillis());
            if (fields != null) {
                Iterator<String> keys = fields.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    event.put(key, fields.get(key));
                }
            }
        } catch (JSONException ignored) {
            // Campos são internos; se falhar, o evento ainda serve de sinal.
        }
        EVENTS.addLast(event);
        while (EVENTS.size() > MAX_EVENTS) {
            EVENTS.removeFirst();
        }
        return lastSeq;
    }

    public static synchronized JSONArray since(long after) {
        JSONArray array = new JSONArray();
        for (JSONObject event : EVENTS) {
            if (event.optLong("seq", 0) > after) {
                array.put(event);
            }
        }
        return array;
    }

    public static synchronized long lastSeq() {
        return lastSeq;
    }

    public static void log(String message) {
        JSONObject fields = new JSONObject();
        try {
            fields.put("message", message);
        } catch (JSONException ignored) {
        }
        emit("log", fields);
    }
}
