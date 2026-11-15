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
        AvisosZap.iniciar(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean embutido = Config.embutido(this);
        // Embutido no Radinho: só vira serviço em primeiro plano (notificação fixa) se o usuário
        // ligou "Manter aberto em segundo plano". Sem isso, o Android congela o processo do motor
        // em segundo plano e as mensagens chegam atrasadas; com isso, chegam na hora.
        if (embutido && !Integracao.manter(this)) {
            try { stopForeground(true); } catch (Throwable ignored) {}
            return START_STICKY;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel canal = new NotificationChannel(CANAL, "Conexão do Zap", NotificationManager.IMPORTANCE_MIN);
            canal.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(canal);
        }
        PendingIntent abrir = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CANAL)
                : new Notification.Builder(this);
        Notification n = b.setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(embutido ? "Zap ativo" : "WhatsApp (Chat Slim)")
                .setContentText("Recebendo mensagens em segundo plano")
                .setContentIntent(abrir)
                .setOngoing(true)
                .build();

        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(7301, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(7301, n);
            }
        } catch (Throwable ignored) {}
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return new Binder();
    }

    /** Embutido no Radinho: o app fechou (ninguém mais ligado ao motor) — encerra o motor junto. */
    @Override
    public void onDestroy() {
        super.onDestroy();
        if (Config.embutido(this)) {
            android.os.Process.killProcess(android.os.Process.myPid());
        }
    }
}
