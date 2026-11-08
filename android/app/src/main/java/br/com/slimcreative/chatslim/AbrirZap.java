package br.com.slimcreative.chatslim;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Tocou numa notificação do Zap: guarda qual conversa abrir e abre o app.
 * A página pergunta isso pra ponte (ChatSlimNativo.conversaPendente).
 */
public class AbrirZap extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String jid = getIntent() != null ? getIntent().getStringExtra("jid") : null;
        if (jid != null) {
            getSharedPreferences("zap", MODE_PRIVATE).edit()
                    .putString("abrir_jid", jid).putLong("abrir_em", System.currentTimeMillis()).apply();
        }
        Intent app = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (app != null) {
            app.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(app);
        }
        finish();
    }
}
