package br.com.slimcreative.chatslim;

import android.content.Context;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * "Push" do Zap: o WhatsApp oficial do celular recebe push do Google e mostra uma notificação.
 * Quando isso acontece, este serviço garante o motor ligado e manda ele "acordar":
 * confere a conexão (morta = reconecta na hora) e puxa o que faltou.
 * NUNCA desliga o motor. Ele NÃO lê o conteúdo da notificação — só de qual app ela veio.
 */
public class ZapEscuta extends NotificationListenerService {
    private static long ultimo = 0;

    @Override
    public void onListenerConnected() {
        try { Integracao.ligarMotor(getApplicationContext()); } catch (Throwable ignored) {}
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            String p = sbn.getPackageName();
            if (p == null || !p.startsWith("com.whatsapp")) return;
            if (sbn.isOngoing()) return; // "WhatsApp Web ativo", ligação em andamento etc.
            acordar(getApplicationContext());
        } catch (Throwable ignored) {}
    }

    static synchronized void acordar(final Context app) {
        long agora = System.currentTimeMillis();
        if (agora - ultimo < 4000) return;          // várias notificações juntas: uma vez só
        ultimo = agora;
        try { Integracao.ligarMotor(app); } catch (Throwable ignored) {}
        new Thread(() -> {
            // o motor pode estar subindo: tenta algumas vezes
            for (int i = 0; i < 6; i++) {
                if (cutucar(app)) return;
                try { Thread.sleep(2500); } catch (InterruptedException e) { return; }
            }
        }, "zap-acordar").start();
    }

    private static boolean cutucar(Context app) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(Config.endereco(app) + "/api/acordar").openConnection();
            c.setConnectTimeout(2000);
            c.setReadTimeout(5000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("X-ChatSlim", "1");
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write("{\"origem\":\"aviso\"}".getBytes("UTF-8")); }
            return c.getResponseCode() == 200;
        } catch (Throwable e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
