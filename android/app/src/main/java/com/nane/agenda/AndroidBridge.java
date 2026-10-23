package com.nane.agenda;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.google.firebase.messaging.FirebaseMessaging;

public final class AndroidBridge {
    private final MainActivity activity;
    private final WebView webView;
    AndroidBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface public boolean hasNotificationPermission() {
        return activity.hasNotificationPermission();
    }
    @JavascriptInterface public boolean hasExactAlarmAccess() {
        return activity.hasExactAlarmAccess();
    }
    @JavascriptInterface public void requestNotificationPermission() {
        activity.requestNotificationPermission();
    }
    @JavascriptInterface public void openNotificationSettings() {
        activity.openNotificationSettings();
    }
    @JavascriptInterface public void openExactAlarmSettings() {
        activity.openExactAlarmSettings();
    }
    @JavascriptInterface public boolean scheduleReminder(String key, String atMillis, String title, String body) {
        try {
            long when = Long.parseLong(atMillis);
            return AlarmScheduler.schedule(activity.getApplicationContext(), key, when, title, body);
        } catch (Exception e) {
            return false;
        }
    }
    @JavascriptInterface public void cancelReminder(String key) {
        AlarmScheduler.cancel(activity.getApplicationContext(), key);
    }
    @JavascriptInterface public void openWhatsApp(String phone, String message) {
        activity.openWhatsApp(phone, message);
    }
    @JavascriptInterface public void exportBackup(String json) {
        activity.launchExport(json);
    }
    @JavascriptInterface public void importBackup() {
        activity.launchImport();
    }
    @JavascriptInterface public void showToast(String message) {
        activity.toast(message);
    }
    @JavascriptInterface public String getSecureValue(String key) {
        return SecureStore.get(activity, key);
    }
    @JavascriptInterface public void saveSecureValue(String key, String value) {
        SecureStore.put(activity, key, value);
        if (ApiConfig.SESSION_KEY.equals(key)) {
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token ->
                    FcmDeviceRegistration.register(activity.getApplicationContext(), token));
        }
        activity.enqueueOrderSync();
    }
    @JavascriptInterface public void removeSecureValue(String key) {
        SecureStore.remove(activity, key);
    }
}
