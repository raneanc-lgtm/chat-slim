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
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

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
     * Botão voltar do Radinho: se tiver algo aberto na página (conversa, foto, perfil...)
     * a página fecha isso; senão o app fecha de vez e sai da lista de apps abertos
     * (o rádio em stand-by e o Zap continuam recebendo por trás).
     */
    public static void voltar(Activity act, WebView web) {
        try {
            web.evaluateJavascript("(function(){try{return window.radinhoVoltar?radinhoVoltar():false}catch(e){return false}})()",
                    v -> {
                        if (!"true".equals(v)) act.finishAndRemoveTask();
                    });
        } catch (Throwable e) {
            act.finishAndRemoveTask();
        }
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
            return 4;
        }

        /** Conversa que a pessoa tocou na notificação (e limpa). */
        @JavascriptInterface
        public String conversaPendente() {
            android.content.SharedPreferences p = act.getSharedPreferences("zap", Context.MODE_PRIVATE);
            String jid = p.getString("abrir_jid", "");
            long em = p.getLong("abrir_em", 0);
            p.edit().remove("abrir_jid").apply();
            return System.currentTimeMillis() - em < 5 * 60 * 1000 ? jid : "";
        }

        /** Salva uma mídia do Zap (caminho dentro de /midia) na galeria. Devolve "ok", "permissao" ou o erro. */
        @JavascriptInterface
        public String salvar(String caminho, String nome) {
            return Galeria.salvar(act, Config.endereco(act) + "/midia/" + caminho, nome);
        }

        @JavascriptInterface
        public int porta() {
            return Config.porta(act);
        }

        /** Abre um link fora do app (mapa, site, telefone...). */
        @JavascriptInterface
        public void abrirLink(String url) {
            act.runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    act.startActivity(i);
                } catch (Throwable ignored) {}
            });
        }

        private static volatile Location melhor;
        private static volatile long pediuEm;

        /**
         * Localização atual: "lat,lng,precisao,idadeSegundos", ou "permissao" (pediu a permissão agora),
         * "desligado" (GPS desligado) ou "" (ainda procurando — chame de novo em meio segundo).
         */
        @JavascriptInterface
        public String localizacao() {
            try {
                if (Build.VERSION.SDK_INT >= 23
                        && act.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                        && act.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                    act.runOnUiThread(() -> act.requestPermissions(new String[]{
                            android.Manifest.permission.ACCESS_FINE_LOCATION,
                            android.Manifest.permission.ACCESS_COARSE_LOCATION}, 7701));
                    return "permissao";
                }
                final LocationManager lm = (LocationManager) act.getSystemService(Context.LOCATION_SERVICE);
                if (lm == null) return "desligado";
                java.util.List<String> provs = lm.getProviders(true);
                if (provs == null || provs.isEmpty()) return "desligado";
                for (String p : provs) {
                    try {
                        Location l = lm.getLastKnownLocation(p);
                        if (l != null && (melhor == null || l.getTime() > melhor.getTime())) melhor = l;
                    } catch (SecurityException ignored) {}
                }
                // pede uma leitura nova (no máximo a cada 20 s)
                if (System.currentTimeMillis() - pediuEm > 20000) {
                    pediuEm = System.currentTimeMillis();
                    act.runOnUiThread(() -> {
                        final LocationListener ouvinte = new LocationListener() {
                            @Override public void onLocationChanged(Location l) { melhor = l; }
                            @Override public void onStatusChanged(String p, int s, Bundle b) {}
                            @Override public void onProviderEnabled(String p) {}
                            @Override public void onProviderDisabled(String p) {}
                        };
                        for (String p : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                            try { if (lm.isProviderEnabled(p)) lm.requestLocationUpdates(p, 0, 0, ouvinte, Looper.getMainLooper()); }
                            catch (Throwable ignored) {}
                        }
                        new Handler(Looper.getMainLooper()).postDelayed(() -> { try { lm.removeUpdates(ouvinte); } catch (Throwable ignored) {} }, 30000);
                    });
                }
                Location l = melhor;
                if (l == null) return "";
                long idade = (System.currentTimeMillis() - l.getTime()) / 1000;
                return l.getLatitude() + "," + l.getLongitude() + "," + Math.round(l.getAccuracy()) + "," + idade;
            } catch (Throwable e) {
                return "";
            }
        }
    }
}
