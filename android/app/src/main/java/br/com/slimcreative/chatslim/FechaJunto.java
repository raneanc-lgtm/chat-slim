package br.com.slimcreative.chatslim;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * Embutido no Radinho: avisa quando o app é arrastado da lista de apps abertos.
 * Configuração "Manter aberto em segundo plano" desligada → para rádio, motor e encerra tudo.
 * Ligada → não faz nada (rádio e Zap continuam recebendo por trás).
 */
public class FechaJunto extends Service {
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_NOT_STICKY; }

    @Override public void onTaskRemoved(Intent rootIntent) {
        if (Integracao.manter(this)) return;
        Integracao.pararTudo(getApplicationContext());
    }
}
