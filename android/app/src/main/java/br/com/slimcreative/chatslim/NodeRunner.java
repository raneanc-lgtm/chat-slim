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

    static {
        System.loadLibrary("node");
        System.loadLibrary("chatslim-node");
    }

    private static native int startNode(String[] args);

    private NodeRunner() {}

    public static synchronized void iniciar(Context ctx) {
        if (iniciado) return;
        iniciado = true;

        final Context app = ctx.getApplicationContext();
        Thread t = new Thread(null, () -> {
            try {
                File destino = new File(app.getFilesDir(), PASTA_MOTOR);
                prepararMotor(app, destino);

                // dados graváveis (conversas, mídia, sessão do WhatsApp) ficam fora da pasta do motor,
                // então sobrevivem a atualizações do app
                Os.setenv("NODEJS_MOBILE_APP_STORAGE", app.getFilesDir().getAbsolutePath(), true);
                Os.setenv("TMPDIR", app.getCacheDir().getAbsolutePath(), true);
                Os.setenv("HOME", app.getFilesDir().getAbsolutePath(), true);

                String principal = new File(destino, "main.js").getAbsolutePath();
                int codigo = startNode(new String[]{"node", principal});
                Log.e(TAG, "Node encerrou com código " + codigo);
            } catch (Throwable e) {
                Log.e(TAG, "Falha ao iniciar o motor", e);
            }
        }, "node-motor", 16L * 1024 * 1024);
        t.start();
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
