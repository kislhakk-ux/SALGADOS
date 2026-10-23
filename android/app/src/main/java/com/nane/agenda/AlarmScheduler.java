package com.nane.agenda;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import org.json.JSONException;
import org.json.JSONArray;
import org.json.JSONObject;

public final class AlarmScheduler {
    private static final String PREFS = "agenda_nane_reminders";
    private static final String ITEMS = "items";
    private AlarmScheduler() {}

    private static PendingIntent pendingIntent(Context context, String key, String title, String body) {
        Intent intent = new Intent(context, ReminderReceiver.class);
        intent.setAction(context.getPackageName() + ".REMINDER");
        intent.setData(Uri.parse("nane://reminder/" + Uri.encode(key)));
        intent.putExtra("key", key);
        intent.putExtra("title", title);
        intent.putExtra("body", body);
        return PendingIntent.getBroadcast(context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    public static synchronized boolean schedule(Context context, String key, long when,
                                                String title, String body) {
        if (key == null || key.isEmpty()) return false;
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        PendingIntent operation = pendingIntent(context, key, title, body);
        manager.cancel(operation);
        if (when <= System.currentTimeMillis()) {
            removeStored(context, key);
            return true;
        }
        try {
            if (Build.VERSION.SDK_INT >= 23) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, operation);
            else manager.setExact(AlarmManager.RTC_WAKEUP, when, operation);
        } catch (SecurityException denied) {
            try {
                if (Build.VERSION.SDK_INT >= 23) manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, operation);
                else manager.set(AlarmManager.RTC_WAKEUP, when, operation);
            } catch (Exception failure) {
                return false;
            }
        } catch (Exception failure) {
            return false;
        }
        try {
            JSONObject item = new JSONObject();
            item.put("when", when);
            item.put("title", title == null ? "Novo lembrete" : title);
            item.put("body", body == null ? "" : body);
            JSONObject all = readAll(context);
            all.put(key, item);
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(ITEMS, all.toString()).apply();
        } catch (JSONException ignored) { }
        return true;
    }

    public static synchronized void cancel(Context context, String key) {
        if (key == null || key.isEmpty()) return;
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        manager.cancel(pendingIntent(context, key, "", ""));
        removeStored(context, key);
    }

    public static synchronized void syncFromServer(Context context, JSONArray orders) {
        java.util.Set<String> expected = new java.util.HashSet<>();
        long now = System.currentTimeMillis();
        if (orders != null) {
            for (int i = 0; i < orders.length(); i++) {
                JSONObject order = orders.optJSONObject(i);
                if (order == null) continue;
                String stage = order.optString("stage", "");
                if ("Entregue".equals(stage) || "Cancelado".equals(stage)) continue;
                long deliveryAt = order.optLong("scheduledAtMillis", 0);
                if (deliveryAt <= now) continue;
                String id = order.optString("id", "");
                if (id.isEmpty()) continue;
                String client = order.optString("client", "cliente");
                String items = order.optString("items", "Pedido agendado");
                String date = order.optString("date", "");
                String time = order.optString("time", "");
                for (String[] reminder : new String[][]{
                        {"24", "86400000", "Falta 1 dia"},
                        {"12", "43200000", "Faltam 12 horas"}
                }) {
                    boolean enabled = order.optBoolean("r" + reminder[0], true);
                    long when = deliveryAt - Long.parseLong(reminder[1]);
                    String key = id + "_" + reminder[0];
                    if (enabled && when > now) {
                        expected.add(key);
                        schedule(context, key, when,
                                reminder[2] + ": pedido de " + client,
                                items + " · " + date + " às " + time + ". Confira sua agenda.");
                    } else {
                        cancel(context, key);
                    }
                }
            }
        }
        JSONObject stored = readAll(context);
        java.util.Iterator<String> keys = stored.keys();
        java.util.List<String> stale = new java.util.ArrayList<>();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!expected.contains(key)) stale.add(key);
        }
        for (String key : stale) cancel(context, key);
    }

    static synchronized void forget(Context context, String key) {
        removeStored(context, key);
    }

    private static JSONObject readAll(Context context) {
        try {
            String value = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(ITEMS, "{}");
            return new JSONObject(value == null ? "{}" : value);
        } catch (Exception e) { return new JSONObject(); }
    }

    private static void removeStored(Context context, String key) {
        JSONObject all = readAll(context);
        all.remove(key);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(ITEMS, all.toString()).apply();
    }

    static synchronized void restore(Context context) {
        JSONObject all = readAll(context);
        java.util.Iterator<String> keys = all.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            JSONObject item = all.optJSONObject(key);
            if (item == null) { keys.remove(); continue; }
            long when = item.optLong("when", 0);
            if (when <= System.currentTimeMillis()) { keys.remove(); continue; }
            schedule(context, key, when, item.optString("title"), item.optString("body"));
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(ITEMS, all.toString()).apply();
    }
}
