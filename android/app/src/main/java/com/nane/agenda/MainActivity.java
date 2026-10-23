package com.nane.agenda;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

public final class MainActivity extends Activity {
    private static final int REQUEST_NOTIFICATIONS = 81;
    private static final int REQUEST_EXPORT = 82;
    private static final int REQUEST_IMPORT = 83;
    private WebView webView;
    private String exportJson;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(0xFFFFF8EF);
        getWindow().setNavigationBarColor(0xFFFFF8EF);
        if (Build.VERSION.SDK_INT >= 23) {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        createNotificationChannel();
        schedulePeriodicOrderSync();
        webView = new WebView(this);
        webView.setBackgroundColor(0xFFFAF5EE);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !url.startsWith("file:///android_asset/");
            }
        });
        webView.addJavascriptInterface(new AndroidBridge(this, webView), "Android");
        setContentView(webView);
        webView.loadUrl("file:///android_asset/index.html");
    }

    void enqueueOrderSync() {
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(OrderSyncWorker.class)
                    .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .build();
            WorkManager.getInstance(getApplicationContext()).enqueue(request);
        } catch (Exception ignored) { }
    }

    private void schedulePeriodicOrderSync() {
        try {
            PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(OrderSyncWorker.class, 1, TimeUnit.HOURS)
                    .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .build();
            WorkManager.getInstance(getApplicationContext()).enqueueUniquePeriodicWork(
                    "nane-orders-sync", ExistingPeriodicWorkPolicy.KEEP, request);
        } catch (Exception ignored) { }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                NotificationChannel channel = new NotificationChannel(
                        ReminderReceiver.CHANNEL_ID,
                        "Lembretes de pedidos",
                        NotificationManager.IMPORTANCE_HIGH);
                channel.setDescription("Avisos antes das entregas e retiradas da Agenda Nane.");
                manager.createNotificationChannel(channel);
                NotificationChannel ordersChannel = new NotificationChannel(
                        "nane_orders",
                        "Novos pedidos",
                        NotificationManager.IMPORTANCE_HIGH);
                ordersChannel.setDescription("Avisos quando chega um agendamento pela loja.");
                manager.createNotificationChannel(ordersChannel);
            }
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.postDelayed(() -> webView.evaluateJavascript(
                    "if(window.onNativeStatusChanged)window.onNativeStatusChanged()", null), 250);
        }
    }

    boolean hasNotificationPermission() {
        return Build.VERSION.SDK_INT < 33 ||
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    boolean hasExactAlarmAccess() {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager manager = getSystemService(AlarmManager.class);
        return manager != null && manager.canScheduleExactAlarms();
    }

    void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && !hasNotificationPermission()) {
            runOnUiThread(() -> requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS));
        }
    }

    void openNotificationSettings() {
        runOnUiThread(() -> {
            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            startActivity(intent);
        });
    }

    void openExactAlarmSettings() {
        runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 31 && !hasExactAlarmAccess()) {
                Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                        Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            }
        });
    }

    void launchExport(String json) {
        runOnUiThread(() -> {
            exportJson = json;
            String name = "agenda-nane-backup.json";
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json");
            intent.putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(intent, REQUEST_EXPORT);
        });
    }

    void launchImport() {
        runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain"});
            startActivityForResult(intent, REQUEST_IMPORT);
        });
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        try {
            if (requestCode == REQUEST_EXPORT && exportJson != null) {
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) throw new IllegalStateException("Não foi possível abrir o arquivo.");
                    out.write(exportJson.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }
                toast("Backup salvo com sucesso.");
            } else if (requestCode == REQUEST_IMPORT) {
                try (InputStream in = getContentResolver().openInputStream(uri);
                     ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    if (in == null) throw new IllegalStateException("Não foi possível ler o arquivo.");
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = in.read(buffer)) != -1) bytes.write(buffer, 0, count);
                    String content = bytes.toString("UTF-8");
                    final String quoted = JSONObject.quote(content);
                    webView.post(() -> webView.evaluateJavascript(
                            "if(window.onBackupImported)window.onBackupImported(" + quoted + ")", null));
                }
            }
        } catch (Exception e) {
            toast("Não foi possível acessar o arquivo do backup.");
        }
    }

    void openWhatsApp(String phone, String message) {
        String digits = phone == null ? "" : phone.replaceAll("[^0-9]", "");
        if (digits.length() == 10 || digits.length() == 11) digits = "55" + digits;
        final String waDigits = digits;
        if (digits.isEmpty()) {
            toast("Cadastre o WhatsApp do cliente para abrir a conversa.");
            return;
        }
        runOnUiThread(() -> {
            try {
                Uri uri = Uri.parse("https://wa.me/" + waDigits + "?text=" + Uri.encode(message == null ? "" : message));
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception e) {
                toast("Não foi possível abrir o WhatsApp neste aparelho.");
            }
        });
    }

    void toast(String message) {
        runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_SHORT).show());
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NOTIFICATIONS && webView != null) {
            boolean granted = hasNotificationPermission();
            webView.post(() -> webView.evaluateJavascript(
                    "if(window.onNativeStatusChanged)window.onNativeStatusChanged()", null));
            if (!granted) toast("Ative as notificações nas configurações do app para receber os lembretes.");
        }
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
