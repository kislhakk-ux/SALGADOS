package com.nane.agenda;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.work.Constraints;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

public final class NaneMessagingService extends FirebaseMessagingService {
    @Override public void onNewToken(String token) {
        FcmDeviceRegistration.register(getApplicationContext(), token);
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        String type = message.getData().get("type");
        if (!"new_order".equals(type)) return;
        enqueueSync();
        RemoteMessage.Notification content = message.getNotification();
        showNotification(
                content == null ? "Novo pedido agendado" : content.getTitle(),
                content == null ? "Um novo pedido chegou pela loja. Confira sua agenda." : content.getBody(),
                message.getData().get("orderId"));
    }

    private void enqueueSync() {
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(OrderSyncWorker.class)
                    .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .build();
            WorkManager.getInstance(getApplicationContext()).enqueue(request);
        } catch (Exception ignored) { }
    }

    private void showNotification(String title, String body, String orderId) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, "nane_orders")
                : new Notification.Builder(this);
        String safeTitle = title == null || title.isEmpty() ? "Novo pedido agendado" : title;
        String safeBody = body == null || body.isEmpty() ? "Um novo pedido chegou pela loja." : body;
        Notification notification = builder
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setStyle(new Notification.BigTextStyle().bigText(safeBody))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_HIGH)
                .build();
        int id = orderId == null ? (int) System.currentTimeMillis() : (orderId.hashCode() & 0x7fffffff);
        manager.notify(id, notification);
    }
}
