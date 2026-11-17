package com.gymburn.bridge;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * HTTP mínimo em 127.0.0.1 — o GymBurn chama de dentro do próprio celular.
 *
 * Fica só no loopback: nenhum outro aparelho da rede alcança a esteira por aqui.
 */
public final class BridgeHttpServer {

    public interface Handler {
        JSONObject handle(String method, String path, Map<String, String> query, JSONObject body) throws Exception;
    }

    private final int port;
    private final Handler handler;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    private volatile ServerSocket serverSocket;
    private volatile boolean running;
    private Thread acceptThread;

    public BridgeHttpServer(int port, Handler handler) {
        this.port = port;
        this.handler = handler;
    }

    public synchronized void start() throws IOException {
        if (running) {
            return;
        }
        serverSocket = new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
        running = true;
        acceptThread = new Thread(this::acceptLoop, "bridge-http");
        acceptThread.setDaemon(true);
        acceptThread.start();
        EventBus.log("HTTP local na porta " + port);
    }

    public synchronized void stop() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
        pool.shutdownNow();
        EventBus.log("HTTP local parado");
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = serverSocket.accept();
                pool.submit(() -> handleConnection(socket));
            } catch (IOException error) {
                if (running) {
                    EventBus.log("HTTP accept falhou: " + error.getMessage());
                }
            } catch (RuntimeException error) {
                if (running) {
                    EventBus.log("HTTP accept erro: " + error);
                }
            }
        }
    }

    private void handleConnection(Socket socket) {
        try (Socket open = socket) {
            open.setSoTimeout(20000);
            InputStream input = open.getInputStream();
            OutputStream output = open.getOutputStream();

            String requestLine = readLine(input);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                sendJson(output, error("requisição inválida"));
                return;
            }
            String method = parts[0].toUpperCase(Locale.US);
            String target = parts[1];

            int contentLength = 0;
            String header;
            while ((header = readLine(input)) != null && !header.isEmpty()) {
                String lower = header.toLowerCase(Locale.US);
                if (lower.startsWith("content-length:")) {
                    try {
                        contentLength = Integer.parseInt(header.substring("content-length:".length()).trim());
                    } catch (NumberFormatException ignored) {
                    }
                }
            }

            String bodyText = "";
            if (contentLength > 0) {
                byte[] raw = new byte[contentLength];
                int offset = 0;
                while (offset < contentLength) {
                    int read = input.read(raw, offset, contentLength - offset);
                    if (read < 0) {
                        break;
                    }
                    offset += read;
                }
                bodyText = new String(raw, 0, offset, StandardCharsets.UTF_8);
            }

            String path = target;
            Map<String, String> query = new HashMap<>();
            int question = target.indexOf('?');
            if (question >= 0) {
                path = target.substring(0, question);
                for (String pair : target.substring(question + 1).split("&")) {
                    if (pair.isEmpty()) {
                        continue;
                    }
                    int equals = pair.indexOf('=');
                    try {
                        if (equals < 0) {
                            query.put(URLDecoder.decode(pair, "UTF-8"), "");
                        } else {
                            query.put(
                                    URLDecoder.decode(pair.substring(0, equals), "UTF-8"),
                                    URLDecoder.decode(pair.substring(equals + 1), "UTF-8"));
                        }
                    } catch (IllegalArgumentException ignored) {
                    }
                }
            }

            JSONObject body = new JSONObject();
            if (!bodyText.isEmpty()) {
                try {
                    body = new JSONObject(bodyText);
                } catch (JSONException error) {
                    sendJson(output, error("JSON inválido no corpo: " + error.getMessage()));
                    return;
                }
            }

            JSONObject response;
            try {
                response = handler.handle(method, path, query, body);
                if (response == null) {
                    response = new JSONObject();
                }
                try {
                    response.put("ok", response.optBoolean("ok", true));
                } catch (JSONException ignored) {
                }
            } catch (Exception error) {
                response = error(error.getMessage() == null ? error.toString() : error.getMessage());
            }
            sendJson(output, response);
        } catch (IOException error) {
            EventBus.log("HTTP conexão falhou: " + error.getMessage());
        } catch (RuntimeException error) {
            EventBus.log("HTTP erro: " + error);
        }
    }

    private static JSONObject error(String message) {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", false);
            out.put("error", message);
        } catch (JSONException ignored) {
        }
        return out;
    }

    private static void sendJson(OutputStream output, JSONObject payload) throws IOException {
        byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        output.write(head.getBytes(StandardCharsets.UTF_8));
        output.write(bytes);
        output.flush();
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) >= 0) {
            if (value == '\n') {
                break;
            }
            if (value != '\r') {
                buffer.write(value);
            }
        }
        if (value < 0 && buffer.size() == 0) {
            return null;
        }
        return buffer.toString(StandardCharsets.UTF_8.name());
    }
}
