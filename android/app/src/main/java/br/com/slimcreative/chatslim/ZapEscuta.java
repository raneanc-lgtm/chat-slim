package br.com.slimcreative.chatslim;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

/**
 * "Push" do Zap: o WhatsApp oficial do celular recebe push do Google e mostra uma notificação.
 * Quando isso acontece, este serviço só acorda o motor do Zap (reconecta e puxa o que faltar).
 * Ele NÃO lê o conteúdo da notificação — olha apenas de qual app ela veio.
 * Sem "Manter aberto", o motor é solto de novo depois de um tempo ocioso (economiza bateria).
 */
public class ZapEscuta extends NotificationListenerService {
    private static final long OCIOSO_MS = 120_000;
    private static Context ctxApp;
    private static final Handler H = new Handler(Looper.getMainLooper());
    private static final Runnable SOLTAR = new Runnable() {
        @Override public void run() { soltarSeOcioso(ctxApp); }
    };

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            String p = sbn.getPackageName();
            if (p == null || !p.startsWith("com.whatsapp")) return;
            if (sbn.isOngoing()) return; // "WhatsApp Web ativo", ligações em andamento etc.
            acordar(getApplicationContext());
        } catch (Throwable ignored) {}
    }

    /** Sobe o motor e agenda a soltura (se "Manter aberto" estiver desligado). */
    static void acordar(Context app) {
        ctxApp = app;
        Integracao.marcarPorAviso();
        Integracao.ligarMotor(app);
        H.removeCallbacks(SOLTAR);
        if (!Integracao.manter(app)) H.postDelayed(SOLTAR, OCIOSO_MS);
    }

    private static void soltarSeOcioso(Context app) {
        if (app == null) return;
        if (Integracao.manter(app) || Integracao.telaAberta()) return;
        Integracao.soltarMotor(app);
    }

    /** Fim de uso da tela: se o app foi pro fundo sem "Manter aberto", agenda soltar também. */
    static void telaFechou(Context app) {
        ctxApp = app;
        H.removeCallbacks(SOLTAR);
        // só solta sozinho se foi o aviso que acordou; fora isso o comportamento antigo continua
        if (Integracao.acordadoPorAviso() && !Integracao.manter(app)) H.postDelayed(SOLTAR, OCIOSO_MS);
    }
}
