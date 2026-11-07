package br.com.slimcreative.chatslim;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Binder;
import android.os.IBinder;

/**
 * Mantém o motor rodando em segundo plano (pra continuar recebendo mensagens
 * e guardando as apagadas mesmo com o app minimizado).
 */
public class MotorService extends Service {
    private static final String CANAL = "chatslim_motor";

    @Override
    public void onCreate() {
        super.onCreate();
        NodeRunner.iniciar(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Embutido no Radinho: sem notificação própria. O motor fica ligado ao
        // serviço do rádio (Integracao.ligarMotor), que já mantém o app vivo.
        if (Config.embutido(this)) return START_STICKY;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel canal = new NotificationChannel(CANAL, "Conexão do WhatsApp (Chat Slim)", NotificationManager.IMPORTANCE_MIN);
            getSystemService(NotificationManager.class).createNotificationChannel(canal);
        }
        PendingIntent abrir = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CANAL)
                : new Notification.Builder(this);
        Notification n = b.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("WhatsApp (Chat Slim)")
                .setContentText("Conectado em segundo plano")
                .setContentIntent(abrir)
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(7301, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(7301, n);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return new Binder();
    }
}
