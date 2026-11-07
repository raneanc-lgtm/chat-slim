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

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String ENDERECO = "http://127.0.0.1:3000";
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
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0e1621"));
        w.setNavigationBarColor(Color.parseColor("#0e1621"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e1621"));
        setContentView(web);
        configurarWebView();

        pedirPermissoesIniciais();
        iniciarMotor();

        web.loadDataWithBaseURL(null, TELA_CARREGANDO, "text/html", "utf-8", null);
        aguardarServidorEAbrir();
    }

    private void iniciarMotor() {
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
            long limite = System.currentTimeMillis() + 90_000;
            while (System.currentTimeMillis() < limite) {
                if (servidorRespondendo()) {
                    ui.post(() -> web.loadUrl(ENDERECO));
                    return;
                }
                try { Thread.sleep(500); } catch (InterruptedException ignored) {}
            }
            ui.post(() -> web.evaluateJavascript(
                    "document.getElementById('m').innerText='O motor não respondeu. Feche e abra o app de novo.'", null));
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
                    if (!"true".equals(valor)) moveTaskToBack(true);
                });
    }
}
