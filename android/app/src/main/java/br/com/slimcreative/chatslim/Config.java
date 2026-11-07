package br.com.slimcreative.chatslim;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;

/**
 * Configuração lida do AndroidManifest (meta-data), pra mesma base de código
 * servir o Chat Slim avulso e o Chat Slim embutido no Radinho.
 *   chatslim.porta     → porta do servidor local (padrão 3000)
 *   chatslim.embutido  → true quando roda dentro de outro app (voltar fecha a tela)
 */
public final class Config {
    private Config() {}

    private static Bundle meta(Context ctx) {
        try {
            ApplicationInfo ai = ctx.getPackageManager()
                    .getApplicationInfo(ctx.getPackageName(), PackageManager.GET_META_DATA);
            return ai.metaData != null ? ai.metaData : new Bundle();
        } catch (Exception e) {
            return new Bundle();
        }
    }

    public static int porta(Context ctx) {
        return meta(ctx).getInt("chatslim.porta", 3000);
    }

    public static boolean embutido(Context ctx) {
        return meta(ctx).getBoolean("chatslim.embutido", false);
    }

    public static String endereco(Context ctx) {
        return "http://127.0.0.1:" + porta(ctx);
    }
}
