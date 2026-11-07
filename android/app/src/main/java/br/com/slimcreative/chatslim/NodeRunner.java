package br.com.slimcreative.chatslim;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Sobe o motor Node.js (Baileys + Express) embarcado no APK.
 * O Node só pode ser iniciado uma vez por processo.
 */
public final class NodeRunner {
    private static final String TAG = "ChatSlim";
    private static final String PASTA_MOTOR = "nodejs-project";
    private static boolean iniciado = false;

    private static native int startNode(String[] args);

    private NodeRunner() {}

    public static synchronized void iniciar(Context ctx) {
        if (iniciado) return;
        iniciado = true;

        final Context app = ctx.getApplicationContext();
        Thread t = new Thread(null, () -> {
            try {
                System.loadLibrary("node");
                System.loadLibrary("chatslim-node");

                File destino = new File(app.getFilesDir(), PASTA_MOTOR);
                prepararMotor(app, destino);

                // dados graváveis (conversas, mídia, sessão do WhatsApp) ficam fora da pasta do motor,
                // então sobrevivem a atualizações do app
                Os.setenv("NODEJS_MOBILE_APP_STORAGE", app.getFilesDir().getAbsolutePath(), true);
                Os.setenv("TMPDIR", app.getCacheDir().getAbsolutePath(), true);
                Os.setenv("HOME", app.getFilesDir().getAbsolutePath(), true);
                Os.setenv("CHATSLIM_PORTA", String.valueOf(Config.porta(app)), true);

                // a mesma configuração vai também pela linha de comando (há aparelhos/emuladores
                // em que o Node não enxerga o setenv feito pelo Java)
                org.json.JSONObject cfg = new org.json.JSONObject();
                cfg.put("NODEJS_MOBILE_APP_STORAGE", app.getFilesDir().getAbsolutePath());
                cfg.put("TMPDIR", app.getCacheDir().getAbsolutePath());
                cfg.put("HOME", app.getFilesDir().getAbsolutePath());
                cfg.put("CHATSLIM_PORTA", String.valueOf(Config.porta(app)));

                // Usa a versão do motor atualizada online (motor-ota), se for mais nova que a do APK
                File pastaMotor = escolherVersao(app, destino);
                String principal = new File(pastaMotor, "main.js").getAbsolutePath();
                int codigo = startNode(new String[]{"node", principal, "--chatslim-config", cfg.toString()});
                Log.e(TAG, "Node encerrou com código " + codigo);
                ChatSlimApp.registrar(app, "crash-motor.txt", "O motor Node parou",
                        new RuntimeException("node::Start retornou " + codigo));
            } catch (Throwable e) {
                Log.e(TAG, "Falha ao iniciar o motor", e);
                ChatSlimApp.registrar(app, "crash-motor.txt", "Falha ao iniciar o motor", e);
            }
        }, "node-motor", 16L * 1024 * 1024);
        t.start();
    }

    private static String lerTexto(File f) throws Exception {
        try (InputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static int lerVersao(File pasta) {
        try {
            return new org.json.JSONObject(lerTexto(new File(pasta, "versao.json"))).optInt("versao", 0);
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Motor atualizado online fica em files/motor-ota. Só é usado se for mais novo que o do APK.
     * Se ele não abrir 3 vezes seguidas (o motor apaga "ota-tentativas" quando sobe ok), é descartado.
     */
    private static File escolherVersao(Context ctx, File doApk) {
        File ota = new File(ctx.getFilesDir(), "motor-ota");
        if (!new File(ota, "main.js").exists() || !new File(ota, "app.js").exists()) return doApk;
        if (lerVersao(ota) <= lerVersao(doApk)) {
            apagar(ota);
            return doApk;
        }
        File cont = new File(ctx.getFilesDir(), "ota-tentativas");
        int n = 0;
        try {
            n = Integer.parseInt(lerTexto(cont).trim());
        } catch (Exception ignored) {}
        if (n >= 3) {
            Log.e(TAG, "Motor online falhou 3 vezes, voltando pro do APK");
            apagar(ota);
            cont.delete();
            return doApk;
        }
        try (FileOutputStream o = new FileOutputStream(cont)) {
            o.write(String.valueOf(n + 1).getBytes("UTF-8"));
        } catch (Exception ignored) {}
        Log.i(TAG, "Usando motor atualizado online, versão " + lerVersao(ota));
        return ota;
    }

    /** Copia o motor dos assets pro armazenamento interno quando o app é instalado/atualizado. */
    private static void prepararMotor(Context ctx, File destino) throws Exception {
        PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
        SharedPreferences prefs = ctx.getSharedPreferences("motor", Context.MODE_PRIVATE);
        long versaoInstalada = prefs.getLong("atualizado_em", -1);

        if (versaoInstalada == info.lastUpdateTime && new File(destino, "main.js").exists()) {
            return;
        }
        apagar(destino);
        copiarAssets(ctx.getAssets(), PASTA_MOTOR, destino);
        prefs.edit().putLong("atualizado_em", info.lastUpdateTime).apply();
    }

    private static void copiarAssets(AssetManager assets, String origem, File destino) throws Exception {
        String[] filhos = assets.list(origem);
        if (filhos != null && filhos.length > 0) {
            destino.mkdirs();
            for (String f : filhos) copiarAssets(assets, origem + "/" + f, new File(destino, f));
        } else {
            destino.getParentFile().mkdirs();
            try (InputStream in = assets.open(origem); OutputStream out = new FileOutputStream(destino)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        }
    }

    private static void apagar(File f) {
        if (!f.exists()) return;
        File[] filhos = f.listFiles();
        if (filhos != null) for (File c : filhos) apagar(c);
        f.delete();
    }
}
