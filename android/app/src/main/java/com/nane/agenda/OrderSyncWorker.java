package com.nane.agenda;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class OrderSyncWorker extends Worker {
    public OrderSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull @Override public Result doWork() {
        String token = SecureStore.get(getApplicationContext(), ApiConfig.SESSION_KEY);
        if (token.isEmpty()) return Result.success();
        HttpURLConnection connection = null;
        try {
            URL url = new URL(ApiConfig.BASE_URL + "/api/admin/orders");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) return Result.success();
            if (status < 200 || status >= 300) return Result.retry();
            String body;
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                body = output.toString("UTF-8");
            }
            JSONObject result = new JSONObject(body);
            JSONArray orders = result.optJSONArray("orders");
            if (orders == null) return Result.retry();
            AlarmScheduler.syncFromServer(getApplicationContext(), orders);
            return Result.success();
        } catch (Exception ignored) {
            return Result.retry();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
