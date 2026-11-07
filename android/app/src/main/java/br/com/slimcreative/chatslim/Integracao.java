package br.com.slimcreative.chatslim;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * Usada quando o Chat Slim vai embutido em outro app (Radinho):
 * liga o motor em segundo plano e expõe window.ChatSlimNativo pra página.
 */
public final class Integracao {
    private Integracao() {}

    public static void instalar(Activity act, WebView web) {
        try {
            web.addJavascriptInterface(new Ponte(act), "ChatSlimNativo");
        } catch (Throwable ignored) {}
        try {
            Intent i = new Intent(act, MotorService.class);
            if (Build.VERSION.SDK_INT >= 26) act.startForegroundService(i);
            else act.startService(i);
        } catch (Throwable ignored) {}
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
            return 1;
        }
    }
}
