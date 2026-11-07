package br.com.slimcreative.chatslim;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.BridgeActivity;
import nodejsmobile.NodeJS;

// ============================================================
// Chat Slim — Activity principal
// ============================================================
// Inicia o motor Node.js embarcado (server.js/motor.js/db.js, que
// roda o Baileys e o servidor Express) e carrega a WebView apontando
// para http://localhost:3000, onde esse motor expõe a interface.
// ============================================================
public class MainActivity extends BridgeActivity {

    private static boolean nodeIniciado = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Pede permissão de microfone/câmera em runtime (Android 6+)
        ActivityCompat.requestPermissions(this, new String[]{
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA
        }, 100);

        if (!nodeIniciado) {
            NodeJS.getInstance().startNodeWithArguments(
                new String[]{"node", "server.js"}
            );
            nodeIniciado = true;
        }

        // Permite que a WebView use microfone/câmera (gravação de áudio, etc.)
        bridge.getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });

        // Aguarda o servidor subir e então aponta a WebView do Capacitor
        // para a interface servida localmente, em vez do public/index.html estático.
        bridge.getWebView().postDelayed(new Runnable() {
            @Override
            public void run() {
                bridge.getWebView().loadUrl("http://localhost:3000");
            }
        }, 1500);
    }
}
