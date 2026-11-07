package br.com.slimcreative.chatslim;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Embutido no Radinho: depois de reiniciar o celular, liga o motor do WhatsApp junto com o rádio. */
public class BootMotor extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Config.embutido(ctx)) Integracao.ligarMotor(ctx.getApplicationContext());
    }
}
