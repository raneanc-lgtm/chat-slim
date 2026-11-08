#!/bin/bash
# Voltar: fecha o app de vez (sai dos recentes) mas o motor continua vivo.
PKG=com.slimcreative.cambio
R=resultado; mkdir -p $R
{
adb install -g teste/Radinho-original.apk >/dev/null && echo "original instalado"
adb install -r -g teste/Radinho-master.apk >/dev/null && echo "master instalado por cima"
adb shell am start -W -n $PKG/.MainActivity | grep -E "TotalTime"; sleep 40
adb exec-out screencap -p > $R/1-aberto.png
echo "--- antes: processos"; adb shell pidof $PKG; adb shell pidof $PKG:motor
echo "--- recentes antes"; adb shell dumpsys activity recents | grep -c "$PKG"
adb shell input keyevent KEYCODE_BACK; sleep 4
adb exec-out screencap -p > $R/2-depois-voltar.png
echo "--- recentes depois (0 = saiu)"; adb shell dumpsys activity recents | grep -c "A=.*$PKG\|$PKG/.MainActivity"
adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -2
sleep 60
echo "--- 60s depois: processos"; adb shell pidof $PKG; adb shell pidof $PKG:motor
echo "--- motor responde?"; adb shell "toybox nc -w 3 127.0.0.1 3010 <<< \$'GET /api/status HTTP/1.0\r\n\r\n'" | tail -1
adb shell run-as $PKG tail -5 files/motor.log
} 2>&1 | tee $R/relatorio.txt
exit 0
