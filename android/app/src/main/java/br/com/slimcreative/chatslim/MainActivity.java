package br.com.slimcreative.chatslim;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Window;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private String ENDERECO = "http://127.0.0.1:3000";
    private static final int REQ_PERMISSOES = 10;
    private static final int REQ_ARQUIVO = 20;
    private static final int REQ_MICROFONE = 30;

    private WebView web;
    private ValueCallback<Uri[]> callbackArquivo;
    private PermissionRequest pedidoMicPendente;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private static final String TELA_CARREGANDO =
            "<html><body style='margin:0;background:#0e1621;color:#e6e6e6;font-family:sans-serif;"
          + "display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column'>"
          + "<div style='font-size:22px;font-weight:bold'>Chat Slim</div>"
          + "<div id='m' style='margin-top:10px;opacity:.7'>Iniciando o motor...</div></body></html>";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            criarTela();
        } catch (Throwable e) {
            ChatSlimApp.registrar(this, "crash-ui.txt", "Erro ao abrir a tela", e);
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setTextIsSelectable(true);
            tv.setPadding(30, 60, 30, 30);
            tv.setText("Chat Slim — erro ao abrir:\n\n" + android.util.Log.getStackTraceString(e));
            setContentView(new android.widget.ScrollView(this) {{ addView(tv); }});
        }
    }

    private void criarTela() {
        ENDERECO = Config.endereco(this);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0e1621"));
        w.setNavigationBarColor(Color.parseColor("#0e1621"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e1621"));
        setContentView(web);
        configurarWebView();

        pedirPermissoesIniciais();
        iniciarMotor();

        if (new File(getFilesDir(), "crash-ui.txt").exists() || new File(getFilesDir(), "crash-motor.txt").exists()) {
            // da última vez deu erro: mostra o que aconteceu antes de seguir
            mostrarDiagnostico("O app fechou com erro da última vez", true);
        } else {
            web.loadDataWithBaseURL(null, TELA_CARREGANDO, "text/html", "utf-8", null);
            aguardarServidorEAbrir();
        }
    }

    // ---------- Diagnóstico (mostra o erro na tela pra tirar print) ----------
    private static String lerFinal(File f, int maxBytes) {
        if (!f.exists()) return "";
        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            long ini = Math.max(0, raf.length() - maxBytes);
            byte[] b = new byte[(int) (raf.length() - ini)];
            raf.seek(ini);
            raf.readFully(b);
            return new String(b, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "(não consegui ler " + f.getName() + ": " + e + ")";
        }
    }

    private static String esc(String t) {
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private void mostrarDiagnostico(String titulo, boolean comBotaoContinuar) {
        File d = getFilesDir();
        String crashUi = lerFinal(new File(d, "crash-ui.txt"), 6000);
        String crashMotor = lerFinal(new File(d, "crash-motor.txt"), 6000);
        String log = lerFinal(new File(d, "motor.log"), 5000);
        StringBuilder h = new StringBuilder();
        h.append("<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>")
         .append("<body style='margin:0;padding:14px;background:#0e1621;color:#e6e6e6;font-family:sans-serif'>")
         .append("<h3 style='margin:0 0 6px'>").append(esc(titulo)).append("</h3>")
         .append("<div style='opacity:.7;font-size:13px;margin-bottom:10px'>Tire print desta tela e mande pro suporte.</div>");
        if (comBotaoContinuar) {
            h.append("<a href='https://chatslim.continuar/' style='display:inline-block;background:#6c5ce7;color:#fff;")
             .append("padding:10px 16px;border-radius:8px;text-decoration:none;margin-bottom:12px'>Continuar</a>");
        }
        secao(h, "Erro do app", crashUi);
        secao(h, "Erro do motor", crashMotor);
        secao(h, "Log do motor (final)", log.isEmpty() ? "(vazio — o motor não chegou a escrever nada)" : log);
        h.append("</body></html>");
        web.loadDataWithBaseURL(null, h.toString(), "text/html", "utf-8", null);
    }

    private static void secao(StringBuilder h, String nome, String conteudo) {
        if (conteudo == null || conteudo.isEmpty()) return;
        h.append("<div style='font-weight:bold;margin-top:10px'>").append(nome).append("</div>")
         .append("<pre style='white-space:pre-wrap;word-break:break-all;font-size:11px;background:#17212b;")
         .append("padding:8px;border-radius:6px'>").append(esc(conteudo)).append("</pre>");
    }

    private void continuarDepoisDoDiagnostico() {
        new File(getFilesDir(), "crash-ui.txt").delete();
        new File(getFilesDir(), "crash-motor.txt").delete();
        web.loadDataWithBaseURL(null, TELA_CARREGANDO, "text/html", "utf-8", null);
        aguardarServidorEAbrir();
    }

    private void iniciarMotor() {
        if (Config.embutido(this)) {
            Integracao.ligarMotor(this);
            return;
        }
        Intent i = new Intent(this, MotorService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
    }

    private void configurarWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost())) return false;
                if ("chatslim.continuar".equals(u.getHost())) {
                    continuarDepoisDoDiagnostico();
                    return true;
                }
                // links externos abrem no navegador
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {}
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                ui.post(() -> {
                    if (!"127.0.0.1".equals(request.getOrigin().getHost())) {
                        request.deny();
                        return;
                    }
                    if (temPermissao(Manifest.permission.RECORD_AUDIO)) {
                        request.grant(request.getResources());
                    } else {
                        pedidoMicPendente = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MICROFONE);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (callbackArquivo != null) callbackArquivo.onReceiveValue(null);
                callbackArquivo = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                String[] tipos = params.getAcceptTypes();
                if (tipos != null && tipos.length > 0 && !(tipos.length == 1 && tipos[0].isEmpty())) {
                    List<String> mimes = new ArrayList<>();
                    for (String t : tipos) {
                        for (String p : t.split(",")) {
                            p = p.trim();
                            if (p.contains("/")) mimes.add(p);
                            else if (p.equals(".pdf")) mimes.add("application/pdf");
                            else if (p.equals(".zip")) mimes.add("application/zip");
                            else if (p.equals(".txt")) mimes.add("text/plain");
                            else if (p.equals(".doc")) mimes.add("application/msword");
                            else if (p.equals(".docx")) mimes.add("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
                        }
                    }
                    if (!mimes.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toArray(new String[0]));
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "Escolher arquivo"), REQ_ARQUIVO);
                } catch (Exception e) {
                    callbackArquivo = null;
                    return false;
                }
                return true;
            }
        });
    }

    private void aguardarServidorEAbrir() {
        new Thread(() -> {
            long inicio = System.currentTimeMillis();
            boolean diagnosticoMostrado = false;
            while (System.currentTimeMillis() - inicio < 180_000) {
                if (servidorRespondendo()) {
                    ui.post(() -> web.loadUrl(ENDERECO));
                    return;
                }
                long passou = System.currentTimeMillis() - inicio;
                boolean motorCaiu = new File(getFilesDir(), "crash-motor.txt").exists();
                if (!diagnosticoMostrado && (motorCaiu || passou > 25_000)) {
                    diagnosticoMostrado = true;
                    final String titulo = motorCaiu ? "O motor parou com erro" : "O motor está demorando pra responder";
                    ui.post(() -> mostrarDiagnostico(titulo, false));
                }
                try { Thread.sleep(700); } catch (InterruptedException ignored) {}
            }
        }).start();
    }

    private boolean servidorRespondendo() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(ENDERECO + "/api/status").openConnection();
            c.setConnectTimeout(800);
            c.setReadTimeout(800);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private boolean temPermissao(String p) {
        return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
    }

    private void pedirPermissoesIniciais() {
        List<String> faltando = new ArrayList<>();
        if (!temPermissao(Manifest.permission.RECORD_AUDIO)) faltando.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33 && !temPermissao(Manifest.permission.POST_NOTIFICATIONS)) {
            faltando.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!faltando.isEmpty()) requestPermissions(faltando.toArray(new String[0]), REQ_PERMISSOES);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_MICROFONE && pedidoMicPendente != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                pedidoMicPendente.grant(pedidoMicPendente.getResources());
            } else {
                pedidoMicPendente.deny();
            }
            pedidoMicPendente = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_ARQUIVO && callbackArquivo != null) {
            Uri[] resultado = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                resultado = new Uri[]{data.getData()};
            }
            callbackArquivo.onReceiveValue(resultado);
            callbackArquivo = null;
        }
    }

    @Override
    public void onBackPressed() {
        // se tiver uma conversa aberta, volta pra lista; senão minimiza (sem matar o motor)
        web.evaluateJavascript(
                "(function(){var b=document.getElementById('btn-voltar');"
              + "if(b&&b.offsetParent!==null){b.click();return true;}return false;})()",
                valor -> {
                    if ("true".equals(valor)) return;
                    // embutido no Radinho: volta pro rádio; avulso: só minimiza (motor segue ligado)
                    if (Config.embutido(this)) finish();
                    else moveTaskToBack(true);
                });
    }
}
