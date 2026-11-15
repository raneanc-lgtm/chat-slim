package br.com.slimcreative.chatslim;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Backup completo do Radinho: pega o arquivo do motor por HTTP e grava em
 * Downloads/Radinho/radinho-backup.json. A pasta Downloads sobrevive à
 * desinstalação do app, então na reinstalação o usuário escolhe esse arquivo
 * pra restaurar tudo (histórico + interface). Sobrescreve o backup anterior.
 */
final class Backup {
    private Backup() {}

    static final String NOME = "radinho-backup.json";
    static final String PASTA = "Radinho";

    /** Baixa o backup do motor (url) e grava no Downloads. Retorna "ok" ou "erro: ...". */
    static String salvar(Activity act, String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(60000);
            if (c.getResponseCode() != 200) return "erro: o motor não devolveu o backup";

            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = act.getContentResolver();
                Uri u = acharExistente(cr);           // sobrescreve o backup anterior, sem criar cópias
                if (u == null) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, NOME);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + PASTA);
                    u = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                }
                if (u == null) return "erro: o sistema recusou a pasta Downloads";
                try (InputStream in = c.getInputStream(); OutputStream out = cr.openOutputStream(u, "wt")) {
                    copiar(in, out);
                }
                return "ok";
            }

            // Android 8 e 9: grava direto (usa a permissão de armazenamento, que o app tem até o SDK 28)
            if (act.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                act.runOnUiThread(() -> act.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 78));
                return "permissao";
            }
            File pasta = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), PASTA);
            pasta.mkdirs();
            File destino = new File(pasta, NOME);
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(destino)) {
                copiar(in, out);
            }
            MediaScannerConnection.scanFile(act, new String[]{destino.getAbsolutePath()}, new String[]{"application/json"}, null);
            return "ok";
        } catch (Exception e) {
            return "erro: " + e.getMessage();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Procura um backup já gravado por este app pra sobrescrever (evita radinho-backup (1).json). */
    private static Uri acharExistente(ContentResolver cr) {
        try {
            String sel = MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + "=?";
            String[] args = { Environment.DIRECTORY_DOWNLOADS + "/" + PASTA + "/", NOME };
            try (Cursor cur = cr.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{ MediaStore.MediaColumns._ID }, sel, args, null)) {
                if (cur != null && cur.moveToFirst()) {
                    long id = cur.getLong(0);
                    return android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id);
                }
            }
        } catch (Throwable ignored) {}
        return null;
    }

    private static void copiar(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }
}
