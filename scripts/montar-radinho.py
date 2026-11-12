#!/usr/bin/env python3
"""
Monta o "Radinho do master": pega o APK do Radinho (o mesmo da galera) e embute
o Chat Slim (motor Node + tela do WhatsApp) dentro dele, mantendo o pacote
com.slimcreative.cambio — assim instala por cima do Radinho atual sem perder
nada (nome, canal e o admin continuam).

Uso:
  python3 montar-radinho.py --apktool apktool.jar --radinho Radinho.apk \
      --chatslim ChatSlim.apk --app-html app.html --saida Radinho-master-sem-assinatura.apk

Depois é só assinar com a chave do Radinho (slimcreative-chave.jks).
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

PORTA_EMBUTIDO = 3010  # diferente do Chat Slim avulso (3000), pra os dois poderem coexistir


def rodar(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"Falhou: {' '.join(cmd)}\n{r.stdout}\n{r.stderr}")
    return r.stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apktool', required=True)
    ap.add_argument('--radinho', required=True)
    ap.add_argument('--chatslim', required=True)
    ap.add_argument('--app-html', required=True)
    ap.add_argument('--saida', required=True)
    ap.add_argument('--teste', action='store_true', help='build de teste: depurável (permite ler o log no emulador)')
    a = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix='montar-radinho-')
    rad = os.path.join(tmp, 'radinho')
    cs = os.path.join(tmp, 'chatslim')
    rodar('java', '-jar', a.apktool, 'd', '-f', a.radinho, '-o', rad)
    rodar('java', '-jar', a.apktool, 'd', '-f', a.chatslim, '-o', cs)

    # 1) classes do Chat Slim (sem o R, que é só dos recursos do app avulso)
    # (o Chat Slim pode vir dividido em vários classesN.dex: junta de todos)
    origens = [r for r, _, _ in os.walk(cs) if r.replace('\\', '/').endswith('br/com/slimcreative/chatslim')]
    if not origens:
        sys.exit('Classes do Chat Slim não encontradas no APK')
    # próximo classesN.dex em sequência (o Android para de ler no primeiro número que faltar)
    n = 2
    while os.path.isdir(os.path.join(rad, f'smali_classes{n}')):
        n += 1
    destino = os.path.join(rad, f'smali_classes{n}', 'br', 'com', 'slimcreative', 'chatslim')
    os.makedirs(destino, exist_ok=True)
    copiadas = 0
    for origem in origens:
        for f in os.listdir(origem):
            if f == 'R.smali' or f.startswith('R$'):
                continue
            shutil.copy2(os.path.join(origem, f), destino)
            copiadas += 1
    if copiadas < 5:
        sys.exit(f'Só {copiadas} classes do Chat Slim encontradas — algo errado no APK de origem')
    print(f'✔ {copiadas} classes do Chat Slim copiadas')

    # 2) bibliotecas nativas (Node + ponte) e o motor
    shutil.copytree(os.path.join(cs, 'lib'), os.path.join(rad, 'lib'), dirs_exist_ok=True)
    shutil.copytree(os.path.join(cs, 'assets', 'nodejs-project'),
                    os.path.join(rad, 'assets', 'nodejs-project'), dirs_exist_ok=True)
    print('✔ libnode + motor copiados')

    # 3) app.html do Radinho (versão com a aba WhatsApp)
    shutil.copy2(a.app_html, os.path.join(rad, 'assets', 'app.html'))
    # carregador com suporte a versão fixada (downgrade)
    shutil.copy2(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'radinho', 'index.html'), os.path.join(rad, 'assets', 'index.html'))
    ver = re.search(r'const APP_VERSAO\s*=\s*(\d+)', open(a.app_html, encoding='utf-8').read())
    print(f'✔ app.html embutido (versão {ver.group(1) if ver else "?"})')

    # 4) MainActivity do Radinho: liga a integração logo depois de expor o RadinhoNativo
    main_smali = None
    for raiz, _, arquivos in os.walk(rad):
        if 'MainActivity.smali' in arquivos and raiz.replace('\\', '/').endswith('com/slimcreative/cambio'):
            main_smali = os.path.join(raiz, 'MainActivity.smali')
    s = open(main_smali, encoding='utf-8').read()
    marcador = re.search(
        r'const-string (v\d+), "RadinhoNativo"\s*\n\s*invoke-virtual \{(v\d+), v\d+, \1\}, '
        r'Landroid/webkit/WebView;->addJavascriptInterface\(Ljava/lang/Object;Ljava/lang/String;\)V\n', s)
    if not marcador:
        sys.exit('Não achei o ponto de integração na MainActivity do Radinho')
    reg_web = marcador.group(2)
    chamada = (f'\n    invoke-static {{p0, {reg_web}}}, Lbr/com/slimcreative/chatslim/Integracao;'
               f'->instalar(Landroid/app/Activity;Landroid/webkit/WebView;)V\n')
    if 'Lbr/com/slimcreative/chatslim/Integracao;' not in s:
        s = s[:marcador.end()] + chamada + s[marcador.end():]
        open(main_smali, 'w', encoding='utf-8').write(s)
    # voltar: fecha o que estiver aberto na página; sem nada aberto, fecha o app de vez
    s = open(main_smali, encoding='utf-8').read()
    m_voltar = re.search(r'\.method public onBackPressed\(\)V.*?\.end method', s, re.S)
    if m_voltar and 'Integracao;->voltar' not in m_voltar.group(0):
        novo = ('.method public onBackPressed()V\n    .locals 1\n\n'
                '    iget-object v0, p0, Lcom/slimcreative/cambio/MainActivity;->web:Landroid/webkit/WebView;\n\n'
                '    invoke-static {p0, v0}, Lbr/com/slimcreative/chatslim/Integracao;->voltar(Landroid/app/Activity;Landroid/webkit/WebView;)V\n\n'
                '    return-void\n.end method')
        s = s[:m_voltar.start()] + novo + s[m_voltar.end():]
        open(main_smali, 'w', encoding='utf-8').write(s)
    print('✔ MainActivity do Radinho ligada ao Chat Slim')

    # 5) Manifest
    mpath = os.path.join(rad, 'AndroidManifest.xml')
    m = open(mpath, encoding='utf-8').read()
    m = re.sub(r'<application ', '<application android:extractNativeLibs="true" '
               'android:networkSecurityConfig="@xml/chatslim_rede" ', m, count=1)
    componentes = f'''
        <activity android:name="br.com.slimcreative.chatslim.MainActivity" android:exported="false"
            android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|screenSize|smallestScreenSize|uiMode"
            android:windowSoftInputMode="adjustResize" android:theme="@android:style/Theme.Material.NoActionBar"/>
        <service android:name="br.com.slimcreative.chatslim.MotorService" android:exported="false"
            android:process=":motor"/>
        <service android:name="br.com.slimcreative.chatslim.FechaJunto" android:exported="false"
            android:stopWithTask="false"/>
        <activity android:name="br.com.slimcreative.chatslim.AbrirZap" android:exported="false"
            android:theme="@android:style/Theme.Translucent.NoTitleBar" android:excludeFromRecents="true"/>
        <meta-data android:name="chatslim.porta" android:value="{PORTA_EMBUTIDO}"/>
        <meta-data android:name="chatslim.embutido" android:value="true"/>
    </application>'''
    m = m.replace('</application>', componentes, 1)
    # arrastar da lista de apps: quem decide é o FechaJunto (configuração "Manter aberto em segundo plano");
    # por isso o serviço do rádio NÃO para sozinho com a tarefa

    # ANTIVÍRUS: o amontoado "mic + câmera + localização + autostart + overlay + ignorar-bateria"
    # casa com a assinatura de espião/stalkerware. Tiramos as permissões perigosas que o app não
    # usa de verdade, pra não cair no falso positivo (nenhuma função é perdida):
    #  - CAMERA: o anexo de foto usa o seletor do sistema (input type=file capture), que chama o
    #    app de Câmera do Android — não precisa da permissão aqui.
    #  - SYSTEM_ALERT_WINDOW (desenhar por cima): declarada mas nenhum código usa.
    #  - RECEIVE_BOOT_COMPLETED + receiver .Boot (ligar sozinho ao reiniciar o celular).
    #  - REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (ninguém pede isso em runtime).
    for p in ('CAMERA', 'SYSTEM_ALERT_WINDOW', 'RECEIVE_BOOT_COMPLETED',
              'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'):
        m = re.sub(r'\s*<uses-permission android:name="android\.permission\.' + p + r'"\s*/>', '', m)
    # tira qualquer <receiver> que escute BOOT_COMPLETED (autostart do rádio)
    m = re.sub(r'\s*<receiver\b(?:(?!</receiver>|/>).)*?BOOT_COMPLETED.*?</receiver>', '', m, flags=re.S)

    perm = '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28"/>'
    if 'WRITE_EXTERNAL_STORAGE' not in m:
        m = m.replace('<application ', perm + '\n    <application ', 1)
    # localização (anexo "Localização" do Zap)
    for pp in ('ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'):
        if pp not in m:
            m = m.replace('<application ', '<uses-permission android:name="android.permission.' + pp + '"/>\n    <application ', 1)
    if a.teste:
        m = m.replace('<application ', '<application android:debuggable="true" ', 1)
    open(mpath, 'w', encoding='utf-8').write(m)

    os.makedirs(os.path.join(rad, 'res', 'xml'), exist_ok=True)
    open(os.path.join(rad, 'res', 'xml', 'chatslim_rede.xml'), 'w', encoding='utf-8').write(
        '<?xml version="1.0" encoding="utf-8"?>\n<network-security-config>\n'
        '    <base-config cleartextTrafficPermitted="false"/>\n'
        '    <domain-config cleartextTrafficPermitted="true">\n'
        '        <domain includeSubdomains="false">127.0.0.1</domain>\n'
        '        <domain includeSubdomains="false">localhost</domain>\n'
        '    </domain-config>\n</network-security-config>\n')
    print('✔ manifest: tela do WhatsApp, serviço do motor e rede local')

    # 6) versão do APK (+1)
    ypath = os.path.join(rad, 'apktool.yml')
    y = open(ypath, encoding='utf-8').read()
    vc = int(re.search(r"versionCode: '?(\d+)'?", y).group(1))
    y = re.sub(r"versionCode: '?\d+'?", f"versionCode: {vc + 1}", y, count=1)
    open(ypath, 'w', encoding='utf-8').write(y)
    print(f'✔ versionCode {vc} → {vc + 1}')

    rodar('java', '-jar', a.apktool, 'b', rad, '-o', a.saida)
    print(f'✔ APK montado (sem assinatura): {a.saida} ({os.path.getsize(a.saida) // 1024 // 1024} MB)')
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
