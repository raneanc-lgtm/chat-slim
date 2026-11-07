package br.com.slimcreative.chatslim;

import android.app.Application;
import android.os.Build;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Date;

/** Grava qualquer erro fatal do Java num arquivo, pra o app mostrar na próxima abertura. */
public class ChatSlimApp extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        final Thread.UncaughtExceptionHandler padrao = Thread.getDefaultUncaughtExceptionHandler();
        final String processo = Build.VERSION.SDK_INT >= 28 ? Application.getProcessName() : "?";
        Thread.setDefaultUncaughtExceptionHandler((thread, erro) -> {
            registrar(this, processo.endsWith(":motor") ? "crash-motor.txt" : "crash-ui.txt",
                    "Thread: " + thread.getName(), erro);
            if (padrao != null) padrao.uncaughtException(thread, erro);
        });
    }

    static void registrar(android.content.Context ctx, String arquivo, String contexto, Throwable erro) {
        try (FileWriter fw = new FileWriter(new File(ctx.getFilesDir(), arquivo), true)) {
            StringWriter sw = new StringWriter();
            erro.printStackTrace(new PrintWriter(sw));
            fw.write("[" + new Date() + "] " + contexto + "\n"
                    + "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ") "
                    + Build.MANUFACTURER + " " + Build.MODEL + " " + String.join(",", Build.SUPPORTED_ABIS) + "\n"
                    + sw + "\n");
        } catch (Exception ignored) {}
    }
}
