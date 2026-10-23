package com.nane.agenda;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class FcmDeviceRegistration {
    private static final String TAG = "AgendaNaneFCM";
    private static final String TOKEN_KEY = "nane_fcm_registered_token";

    private FcmDeviceRegistration() { }

    static void register(Context context, String token) {
        if (token == null || token.length() < 40) return;
        Context appContext = context.getApplicationContext();
        String session = SecureStore.get(appContext, ApiConfig.SESSION_KEY);
        if (session.isEmpty() || token.equals(SecureStore.get(appContext, TOKEN_KEY))) return;
        Thread thread = new Thread(() -> send(appContext, session, token), "nane-fcm-register");
        thread.setDaemon(true);
        thread.start();
    }

    private static void send(Context context, String session, String token) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ApiConfig.BASE_URL + "/api/admin/device-token").openConnection();
            connection.setRequestMethod("PUT");
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Authorization", "Bearer " + session);
            byte[] payload = new JSONObject().put("token", token).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload);
            }
            if (connection.getResponseCode() >= 200 && connection.getResponseCode() < 300) {
                SecureStore.put(context, TOKEN_KEY, token);
            }
        } catch (Exception error) {
            Log.w(TAG, "Could not register this device for push notifications.");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
