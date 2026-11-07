#!/bin/bash
# Instala o APK no emulador, abre o app e coleta tudo que der pra diagnosticar.
PKG=br.com.slimcreative.chatslim
APK=android/app/build/outputs/apk/debug/app-debug.apk
set -x
adb install -r -g "$APK"
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity
sleep 75
set +x
echo "===== PROCESSOS ====="
adb shell pidof $PKG && echo "UI: VIVO" || echo "UI: MORREU"
adb shell pidof $PKG:motor && echo "MOTOR: VIVO" || echo "MOTOR: MORREU"
echo "===== STATUS DO SERVIDOR ====="
adb forward tcp:3000 tcp:3000
curl -s -m 5 http://127.0.0.1:3000/api/status | head -c 300; echo
echo "===== ATIVIDADE EM PRIMEIRO PLANO ====="
adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -3
echo "===== motor.log ====="
adb shell run-as $PKG cat files/motor.log
echo "===== crash-ui.txt ====="
adb shell run-as $PKG cat files/crash-ui.txt
echo "===== crash-motor.txt ====="
adb shell run-as $PKG cat files/crash-motor.txt
echo "===== LOGCAT (filtrado) ====="
adb logcat -d | grep -E -i "chatslim|CHATSLIM-NODE|AndroidRuntime|FATAL|DEBUG +:|libc +:|linker|tombstone" | tail -400
adb exec-out screencap -p > tela-emulador.png
exit 0
