#!/bin/bash
# Mede a abertura do Radinho: original x master (prints a cada segundo depois de abrir).
PKG=com.slimcreative.cambio
R=resultado; mkdir -p $R
medir() {
  local nome=$1
  adb shell am force-stop $PKG; sleep 3
  adb shell am start -n $PKG/.MainActivity >/dev/null
  for s in 1 2 3 4 6 9; do
    sleep $([ $s -le 4 ] && echo 1 || echo 3)
    [ $s -eq 6 ] && sleep 0
    adb exec-out screencap -p > $R/$nome-${s}s.png
  done
}
{
adb install -g teste/Radinho-original.apk >/dev/null && echo "original instalado"
adb shell am start -W -n $PKG/.MainActivity | grep -E "TotalTime"; sleep 15
adb shell input keyevent KEYCODE_BACK; sleep 2
medir original
adb install -r -g teste/Radinho-master.apk >/dev/null && echo "master instalado por cima"
adb shell am start -W -n $PKG/.MainActivity | grep -E "TotalTime"; sleep 40
medir master
echo "--- processos"; adb shell pidof $PKG; adb shell pidof $PKG:motor
echo "--- notificações do app"; adb shell dumpsys notification --noredact | grep -E "pkg=$PKG" | head -5
adb shell dumpsys activity services $PKG | grep -E "ServiceRecord|isForeground" | head -6
adb shell run-as $PKG cat files/motor.log
} 2>&1 | tee $R/relatorio.txt
exit 0
