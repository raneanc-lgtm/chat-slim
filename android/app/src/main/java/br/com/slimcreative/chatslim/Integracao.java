package br.com.slimcreative.chatslim;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * Usada quando o Chat Slim vai embutido em outro app (Radinho):
 * liga o motor em segundo plano e expõe window.ChatSlimNativo pra página.
 */
public final class Integracao {
    private Integracao() {}

    private static ServiceConnection conexao;

    public static void instalar(Activity act, WebView web) {
        try {
            web.addJavascriptInterface(new Ponte(act), "ChatSlimNativo");
            // a página do Radinho (https://appassets...) conversa com o motor local (http://127.0.0.1)
            web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        } catch (Throwable ignored) {}
        // liga o motor um pouco depois, pra não disputar processador com a abertura do Radinho
        final Context app = act.getApplicationContext();
        new Handler(Looper.getMainLooper()).postDelayed(() -> ligarMotor(app), 2500);
    }

    /**
     * Mantém o motor vivo "pendurado" no processo principal do app (que o serviço do
     * rádio já mantém vivo), sem precisar de uma segunda notificação fixa.
     */
    public static synchronized void ligarMotor(Context ctx) {
        if (conexao != null) return;
        conexao = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName n, IBinder b) {}
            @Override public void onServiceDisconnected(ComponentName n) {}
        };
        try {
            ctx.getApplicationContext().bindService(new Intent(ctx, MotorService.class), conexao,
                    Context.BIND_AUTO_CREATE | Context.BIND_IMPORTANT);
        } catch (Throwable e) {
            conexao = null;
        }
    }

    public static final class Ponte {
        private final Activity act;

        Ponte(Activity act) {
            this.act = act;
        }

        @JavascriptInterface
        public void abrir() {
            act.runOnUiThread(() -> act.startActivity(new Intent(act, MainActivity.class)));
        }

        @JavascriptInterface
        public int versao() {
            return 2;
        }

        @JavascriptInterface
        public int porta() {
            return Config.porta(act);
        }
    }
}
