#!/bin/bash
# Teste do Radinho com Chat Slim embutido: instala o Radinho original, depois o novo POR CIMA,
# e confere se rádio + motor do WhatsApp sobem juntos. Resultado vai pra pasta "resultado/".
PKG=com.slimcreative.cambio
R=resultado
mkdir -p $R
{
echo "===== 1) Radinho original ====="
adb install -g teste/Radinho-original.apk
adb shell am start -W -n $PKG/.MainActivity
sleep 20
adb shell run-as $PKG ls -la files shared_prefs app_webview 2>&1 | head -20
adb exec-out screencap -p > $R/1-radinho-original.png
echo "versão antes: $(adb shell dumpsys package $PKG | grep -m1 versionCode)"

echo "===== 2) Radinho master instalado POR CIMA ====="
adb install -r -g teste/Radinho-master.apk && echo "INSTALOU POR CIMA: OK" || echo "INSTALOU POR CIMA: FALHOU"
echo "versão depois: $(adb shell dumpsys package $PKG | grep -m1 versionCode)"
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity
sleep 75
adb exec-out screencap -p > $R/2-radinho-master.png
echo "===== PROCESSOS ====="
adb shell pidof $PKG && echo "RADINHO: VIVO" || echo "RADINHO: MORREU"
adb shell pidof $PKG:motor && echo "MOTOR WHATSAPP: VIVO" || echo "MOTOR WHATSAPP: MORREU"
echo "===== SERVIÇOS EM PRIMEIRO PLANO ====="
adb shell dumpsys activity services $PKG | grep -E "ServiceRecord|isForeground" | head -10
echo "===== MOTOR (porta 3010) ====="
adb forward tcp:3010 tcp:3010
curl -s -m 5 http://127.0.0.1:3010/api/status | head -c 120; echo
echo "===== motor.log ====="
adb shell run-as $PKG cat files/motor.log
adb shell run-as $PKG cat files/crash-motor.txt 2>/dev/null

echo "===== 3) Abrindo a tela do WhatsApp ====="
adb root >/dev/null 2>&1; sleep 3
adb shell am start -W -n $PKG/br.com.slimcreative.chatslim.MainActivity
sleep 12
adb exec-out screencap -p > $R/3-tela-whatsapp.png
adb shell dumpsys activity activities | grep -E "topResumedActivity" | head -2
adb shell input keyevent KEYCODE_BACK
sleep 4
adb exec-out screencap -p > $R/4-voltou-pro-radio.png
adb shell dumpsys activity activities | grep -E "topResumedActivity" | head -2

echo "===== LOGCAT (erros) ====="
adb logcat -d | grep -E "FATAL EXCEPTION|AndroidRuntime|CHATSLIM|ChatSlim|nodejs  :|cambio" | grep -v AppsFilter | tail -120
} 2>&1 | tee $R/relatorio.txt
exit 0
