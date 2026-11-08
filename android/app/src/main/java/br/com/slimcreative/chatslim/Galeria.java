package br.com.slimcreative.chatslim;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
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

/** Salva fotos e vídeos do Zap na galeria do celular (pasta Pictures/Zap ou Movies/Zap). */
final class Galeria {
    private Galeria() {}

    static String salvar(Activity act, String url, String nome) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(60000);
            if (c.getResponseCode() != 200) return "não encontrei o arquivo";
            String mime = c.getContentType();
            if (mime == null) mime = "application/octet-stream";
            mime = mime.split(";")[0].trim();
            boolean video = mime.startsWith("video/");
            boolean imagem = mime.startsWith("image/");
            if (nome == null || nome.isEmpty()) nome = "Zap_" + System.currentTimeMillis();
            nome = nome.replaceAll("[^A-Za-z0-9._ -]", "_");
            if (!nome.contains(".")) {
                String ext = mime.contains("/") ? mime.substring(mime.indexOf('/') + 1) : "bin";
                if (ext.equals("jpeg")) ext = "jpg";
                nome = nome + "." + ext;
            }

            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = act.getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, nome);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                Uri colecao;
                if (video) {
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Zap");
                    colecao = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                } else if (imagem) {
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Zap");
                    colecao = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                } else {
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Zap");
                    colecao = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                }
                Uri u = cr.insert(colecao, v);
                if (u == null) return "a galeria recusou o arquivo";
                try (InputStream in = c.getInputStream(); OutputStream out = cr.openOutputStream(u)) {
                    copiar(in, out);
                }
                return "ok";
            }

            // Android 8 e 9: precisa da permissão de armazenamento
            if (act.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                act.runOnUiThread(() -> act.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 77));
                return "permissao";
            }
            File pasta = new File(Environment.getExternalStoragePublicDirectory(
                    video ? Environment.DIRECTORY_MOVIES : imagem ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS), "Zap");
            pasta.mkdirs();
            File destino = new File(pasta, nome);
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(destino)) {
                copiar(in, out);
            }
            MediaScannerConnection.scanFile(act, new String[]{destino.getAbsolutePath()}, new String[]{mime}, null);
            return "ok";
        } catch (Exception e) {
            return "erro: " + e.getMessage();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void copiar(InputStream in, OutputStream out) throws Exception {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }
}
