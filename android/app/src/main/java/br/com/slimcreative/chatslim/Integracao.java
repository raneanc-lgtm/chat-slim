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
        // liga o motor já (ele roda em outro processo, não atrapalha a abertura da tela)
        ligarMotor(act.getApplicationContext());
        // vigia o "arrastar da lista de apps": fecha tudo ou deixa rodando, conforme a escolha nas configurações
        try { act.startService(new Intent(act, FechaJunto.class)); } catch (Throwable ignored) {}
    }

    /** Escolha do usuário: true = continua rodando em segundo plano quando fecha; false = fechar para tudo. */
    public static boolean manter(Context ctx) {
        return ctx.getSharedPreferences("zap", Context.MODE_PRIVATE).getBoolean("manter_aberto", false);
    }

    /** Para o serviço do rádio (pelo nome, pra não depender do pacote do app que embute). */
    static void pararRadio(Context app) {
        try {
            android.content.pm.PackageInfo pi = app.getPackageManager().getPackageInfo(app.getPackageName(), PackageManager.GET_SERVICES);
            if (pi.services != null) for (android.content.pm.ServiceInfo si : pi.services) {
                if (si.name != null && si.name.endsWith(".RadioService")) {
                    try { app.stopService(new Intent().setClassName(app, si.name)); } catch (Throwable ignored) {}
                }
            }
        } catch (Throwable ignored) {}
    }

    /** Desliga motor e rádio e encerra o processo (usado quando a tarefa é arrastada da lista de apps). */
    static void pararTudo(Context app) {
        try {
            synchronized (Integracao.class) {
                if (conexao != null) { try { app.unbindService(conexao); } catch (Throwable ignored) {} conexao = null; }
            }
        } catch (Throwable ignored) {}
        try { app.stopService(new Intent(app, MotorService.class)); } catch (Throwable ignored) {}
        matarMotor(app);
        pararRadio(app);
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            android.os.Process.killProcess(android.os.Process.myPid());
            System.exit(0);
        }, 500);
    }

    private static void matarMotor(Context app) {
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) app.getSystemService(Context.ACTIVITY_SERVICE);
            for (android.app.ActivityManager.RunningAppProcessInfo pi : am.getRunningAppProcesses()) {
                if (pi.processName != null && pi.processName.endsWith(":motor")) android.os.Process.killProcess(pi.pid);
            }
        } catch (Throwable ignored) {}
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
                        if (!"true".equals(v)) {
                            // escolheu manter aberto: só sai da frente; rádio e Zap continuam por trás
                            if (manter(act)) { try { act.moveTaskToBack(true); } catch (Throwable e2) { act.finish(); } return; }
                            // nada aberto: fechar o app = parar tudo (igual ao "Parar" do Android)
                            try { web.evaluateJavascript("try{window.radinhoFechando&&radinhoFechando()}catch(e){}", null); } catch (Throwable ignored) {}
                            new Handler(Looper.getMainLooper()).postDelayed(() -> encerrar(act), 600);
                        }
                    });
        } catch (Throwable e) {
            if (manter(act)) { try { act.moveTaskToBack(true); } catch (Throwable e2) { act.finish(); } }
            else encerrar(act);
        }
    }

    /** Desliga o motor do Zap, sai da tela e encerra o app. */
    public static void encerrar(Activity act) {
        Context app = act.getApplicationContext();
        try {
            synchronized (Integracao.class) {
                if (conexao != null) { try { app.unbindService(conexao); } catch (Throwable ignored) {} conexao = null; }
            }
        } catch (Throwable ignored) {}
        try { app.stopService(new Intent(app, MotorService.class)); } catch (Throwable ignored) {}
        matarMotor(app);
        pararRadio(app);
        try { act.finishAndRemoveTask(); } catch (Throwable ignored) {}
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            android.os.Process.killProcess(android.os.Process.myPid());
            System.exit(0);
        }, 700);
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
            return 5;
        }

        /** Configuração "Manter aberto em segundo plano": liga/desliga e consulta. */
        @JavascriptInterface
        public void manterAberto(boolean ligar) {
            act.getSharedPreferences("zap", Context.MODE_PRIVATE).edit().putBoolean("manter_aberto", ligar).apply();
        }

        @JavascriptInterface
        public boolean manterAbertoAtual() {
            return manter(act);
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

        /**
         * Fecha o Radinho de vez: desliga o motor do Zap (processo :motor), sai da tela
         * e encerra o app. O rádio a página já desligou antes (standby vazio).
         * Nada fica rodando até você abrir de novo.
         */
        @JavascriptInterface
        public void fecharTudo() {
            act.runOnUiThread(() -> encerrar(act));
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
