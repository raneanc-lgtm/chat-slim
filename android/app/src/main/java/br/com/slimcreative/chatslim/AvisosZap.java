package br.com.slimcreative.chatslim;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Escuta os eventos do motor (SSE em 127.0.0.1) e mostra notificação no topo da tela
 * quando um contato marcado fica online — funciona com o app fechado.
 */
public final class AvisosZap {
    private static final String CANAL = "zap_online";
    private static boolean iniciado = false;

    private AvisosZap() {}

    public static synchronized void iniciar(Context ctx) {
        if (iniciado) return;
        iniciado = true;
        final Context app = ctx.getApplicationContext();
        criarCanal(app);
        new Thread(() -> {
            while (true) {
                try {
                    ouvir(app);
                } catch (Throwable e) {
                    Log.w("ChatSlim", "Avisos: reconectando (" + e.getMessage() + ")");
                }
                try { Thread.sleep(4000); } catch (InterruptedException ignored) {}
            }
        }, "zap-avisos").start();
    }

    private static void criarCanal(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel c = new NotificationChannel(CANAL, "Zap: contato online", NotificationManager.IMPORTANCE_HIGH);
        c.setDescription("Aviso quando um contato marcado fica online");
        c.enableLights(true);
        c.setLightColor(Color.GREEN);
        ctx.getSystemService(NotificationManager.class).createNotificationChannel(c);
    }

    private static void ouvir(Context ctx) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(Config.endereco(ctx) + "/api/eventos").openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(0);
        c.setRequestProperty("Accept", "text/event-stream");
        try (BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            String linha;
            while ((linha = in.readLine()) != null) {
                if (!linha.startsWith("data:")) continue;
                JSONObject ev;
                try { ev = new JSONObject(linha.substring(5).trim()); } catch (Exception e) { continue; }
                if ("alerta_online".equals(ev.optString("tipo"))) {
                    notificarOnline(ctx, ev.optString("jid"), ev.optString("nome", "Contato"));
                }
            }
        } finally {
            c.disconnect();
        }
    }

    private static void notificarOnline(Context ctx, String jid, String nome) {
        Intent abrir = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent pi = abrir == null ? null : PendingIntent.getActivity(ctx, 1, abrir,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CANAL) : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.presence_online)
         .setContentTitle(nome)
         .setContentText("🟢 está online agora")
         .setColor(Color.rgb(61, 220, 132))
         .setAutoCancel(true)
         .setCategory(Notification.CATEGORY_STATUS);
        if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(60 * 1000);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        if (pi != null) b.setContentIntent(pi);
        try {
            ctx.getSystemService(NotificationManager.class).notify(8000 + (jid.hashCode() & 0xfff), b.build());
        } catch (Exception e) {
            Log.w("ChatSlim", "Sem permissão de notificação: " + e.getMessage());
        }
    }
}
