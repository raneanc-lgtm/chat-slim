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

    private static final String CANAL_MSG = "zap_mensagens";

    private static void criarCanal(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel c = new NotificationChannel(CANAL, "Zap: contato online", NotificationManager.IMPORTANCE_HIGH);
        c.setDescription("Aviso quando um contato marcado fica online");
        c.enableLights(true);
        c.setLightColor(Color.GREEN);
        nm.createNotificationChannel(c);
        NotificationChannel m = new NotificationChannel(CANAL_MSG, "Zap: mensagens", NotificationManager.IMPORTANCE_HIGH);
        m.setDescription("Mensagens novas do Zap");
        m.enableLights(true);
        m.setLightColor(Color.GREEN);
        m.enableVibration(true);
        nm.createNotificationChannel(m);
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
                // o motor decide QUANDO notificar (respeita silenciar, app aberto etc.);
                // aqui só mostramos — assim dá pra mudar as regras sem APK novo
                if ("notificar".equals(ev.optString("tipo"))) notificar(ctx, ev);
                else if ("limpar_notificacao".equals(ev.optString("tipo"))) limpar(ctx, ev.optString("jid", ""));
            }
        } finally {
            c.disconnect();
        }
    }

    /** Conversa lida (no Zap ou no WhatsApp oficial): tira a notificação dela da barra. */
    private static void limpar(Context ctx, String jid) {
        try {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            nm.cancel(9000 + (jid.hashCode() & 0x7ff));
        } catch (Exception ignored) {}
    }

    private static void notificar(Context ctx, JSONObject ev) {
        String canal = "online".equals(ev.optString("canal")) ? CANAL : CANAL_MSG;
        String jid = ev.optString("jid", "");
        String titulo = ev.optString("titulo", "Zap");
        String texto = ev.optString("texto", "");

        Intent abrir = new Intent(ctx, AbrirZap.class);
        abrir.putExtra("jid", jid);
        abrir.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(ctx, jid.hashCode(), abrir,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, canal) : new Notification.Builder(ctx);
        b.setSmallIcon(canal.equals(CANAL) ? android.R.drawable.presence_online : android.R.drawable.stat_notify_chat)
         .setContentTitle(titulo)
         .setContentText(texto)
         .setStyle(new Notification.BigTextStyle().bigText(texto))
         .setColor(Color.rgb(61, 220, 132))
         .setAutoCancel(true)
         .setShowWhen(true)
         .setContentIntent(pi)
         .setCategory(canal.equals(CANAL) ? Notification.CATEGORY_STATUS : Notification.CATEGORY_MESSAGE);
        int n = ev.optInt("naoLidas", 0);
        if (n > 1) b.setNumber(n);
        if (Build.VERSION.SDK_INT >= 26 && canal.equals(CANAL)) b.setTimeoutAfter(60 * 1000);
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        try {
            int id = (canal.equals(CANAL) ? 8000 : 9000) + (jid.hashCode() & 0x7ff);
            ctx.getSystemService(NotificationManager.class).notify(id, b.build());
        } catch (Exception e) {
            Log.w("ChatSlim", "Sem permissão de notificação: " + e.getMessage());
        }
    }
}
