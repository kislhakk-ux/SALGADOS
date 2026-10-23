package com.nane.agenda;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class ReminderReceiver extends BroadcastReceiver {
    public static final String CHANNEL_ID = "agenda_nane_pedidos";

    @Override public void onReceive(Context context, Intent intent) {
        String key = intent.getStringExtra("key");
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Lembretes de pedidos", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Avisos antes das entregas e retiradas da Agenda Nane.");
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CHANNEL_ID)
                : new Notification.Builder(context);
        Notification notification = builder
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title == null || title.isEmpty() ? "Lembrete de pedido" : title)
                .setContentText(body == null ? "Confira a agenda da Nane." : body)
                .setStyle(new Notification.BigTextStyle().bigText(body == null ? "Confira a agenda da Nane." : body))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_HIGH)
                .build();
        int notificationId = key == null ? (int) System.currentTimeMillis() : (key.hashCode() & 0x7fffffff);
        manager.notify(notificationId, notification);
        if (key != null) AlarmScheduler.forget(context, key);
    }
}
