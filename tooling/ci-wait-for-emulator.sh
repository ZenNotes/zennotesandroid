#!/bin/sh
# Gate the CI instrumentation run on a HEALTHY emulator, not merely a booted
# one. On GitHub's nested-virt runners the API 35 image sometimes reports
# sys.boot_completed=1 while system_server is still sick: the `settings` and
# `package` services never register, which surfaced as endless
# "Can't find service: settings" warnings in one run and a
# "Failed to commit install session … Broken pipe" in another — with the
# gradle connected-test invocation charging ahead into both. Waiting on the
# services themselves turns a half-boot into either a healthy emulator or a
# loud early failure, and one adb reboot in between usually revives a sick
# system_server without paying for a fresh AVD launch.
set -eu

ADB="${ANDROID_HOME:-/usr/local/lib/android/sdk}/platform-tools/adb"

services_up() {
  [ "$("$ADB" shell settings get global device_provisioned 2>/dev/null | tr -d '\r')" = "1" ] || return 1
  "$ADB" shell pm path android >/dev/null 2>&1 || return 1
  return 0
}

wait_for_services() {
  i=0
  while [ "$i" -lt 60 ]; do # 60 x 5s = 5 minutes
    if services_up; then
      echo "emulator services healthy after $((i * 5))s"
      return 0
    fi
    sleep 5
    i=$((i + 1))
  done
  return 1
}

"$ADB" wait-for-device
if ! wait_for_services; then
  echo "system services never registered; rebooting the emulator once" >&2
  "$ADB" reboot
  "$ADB" wait-for-device
  if ! wait_for_services; then
    echo "emulator still unhealthy after reboot; failing before the test run" >&2
    "$ADB" shell service list 2>&1 | head -20 >&2 || true
    exit 1
  fi
fi
