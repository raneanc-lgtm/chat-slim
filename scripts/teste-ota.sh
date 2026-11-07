#!/bin/bash
# Testa a atualização automática do motor: o APK traz uma versão e no GitHub há uma mais nova.
PKG=com.slimcreative.cambio
R=resultado; mkdir -p $R
{
adb install -g teste/Radinho-master.apk && echo "instalado"
adb shell am start -W -n $PKG/.MainActivity | grep TotalTime
echo "esperando o motor conferir e baixar a versão nova..."
sleep 200
echo "===== motor.log ====="
adb shell run-as $PKG cat files/motor.log
echo "===== pastas ====="
adb shell run-as $PKG ls files files/motor-ota 2>&1
adb shell run-as $PKG cat files/motor-ota/versao.json 2>&1 | head -3
echo "===== processos ====="
adb shell pidof $PKG:motor && echo "MOTOR VIVO" || echo "MOTOR MORTO"
adb forward tcp:3010 tcp:3010; curl -s -m 5 http://127.0.0.1:3010/api/versao; echo
echo "===== notificações ====="
adb shell dumpsys notification --noredact | grep -E "pkg=$PKG" | head -5
} 2>&1 | tee $R/relatorio.txt
exit 0
