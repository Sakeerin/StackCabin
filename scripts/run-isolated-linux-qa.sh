#!/usr/bin/env bash
# CI-only: caller must enter a NEW network namespace, never the host namespace.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "$EUID" -eq 0 && $# -eq 3 ]] || { echo 'CI network-isolation helper only' >&2; exit 1; }
user="$1"; kit="$2"; workspace_root="$3"
[[ "$user" != root && -d "$kit/offline" && -d "$workspace_root" ]] || { echo 'Expected an ordinary runner user and a prepared kit' >&2; exit 1; }
# A fresh namespace contains only loopback. Refuse to alter a host network.
mapfile -t interfaces < <(ip -o link show | awk -F ': ' '{ print $2 }')
[[ ${#interfaces[@]} -eq 1 && "${interfaces[0]}" == lo ]] || { echo 'Refusing a namespace with external interfaces' >&2; exit 1; }
ip link set lo up
echo 'Offline QA network contains loopback only:'
ip -brief address
exec runuser -u "$user" -- env \
  XDG_DATA_HOME="$workspace_root/offline-qa-secrets" \
  STACKCABIN_QA_KIT="$kit" \
  STACKCABIN_QA_WORKSPACE="$workspace_root/disconnected acceptance ทดสอบ" \
  http_proxy=http://127.0.0.1:1 https_proxy=http://127.0.0.1:1 NO_PROXY= \
  dbus-run-session -- bash -eu -c '
    mkdir -p "$XDG_DATA_HOME"
    printf "%s\n" "stackcabin-ci-only" | gnome-keyring-daemon --unlock --components=secrets
    exec bash "$STACKCABIN_QA_KIT/Run-StackCabinAcceptance.sh" "$STACKCABIN_QA_WORKSPACE" "$STACKCABIN_QA_KIT/offline"
  '
