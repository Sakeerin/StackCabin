#!/usr/bin/env bash
# Internal QA only. Run against a new workspace using the matching offline pack.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo 'Usage: Run-StackCabinAcceptance.sh NEW_WORKSPACE MATCHING_OFFLINE_PACK' >&2
  exit 2
fi
kit="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
binary="$kit/native-smoke"
[[ -f "$binary" && -f "$kit/SHA256SUMS.txt" ]] || { echo 'Incomplete acceptance kit' >&2; exit 1; }
case "$(uname -s)" in
  Darwin) actual="$(shasum -a 256 "$binary")" ;;
  Linux) actual="$(sha256sum "$binary")" ;;
  *) echo 'This acceptance kit requires macOS or Linux' >&2; exit 1 ;;
esac
expected="$(awk '$2 == "native-smoke" { print $1 }' "$kit/SHA256SUMS.txt")"
[[ "$expected" =~ ^[0-9a-f]{64}$ && "${actual%% *}" == "$expected" ]] || { echo 'Acceptance binary checksum mismatch' >&2; exit 1; }
workspace="$1"
[[ ! -L "$workspace" ]] || { echo 'Choose a new workspace, not a symbolic link' >&2; exit 1; }
if [[ -e "$workspace" ]]; then
  [[ -d "$workspace" ]] || { echo 'Workspace must be a directory' >&2; exit 1; }
  shopt -s nullglob dotglob
  entries=("$workspace"/*)
  [[ ${#entries[@]} -eq 0 ]] || { echo 'Choose a new or empty dedicated acceptance workspace' >&2; exit 1; }
fi
[[ -d "$2" ]] || { echo 'Matching offline pack directory not found' >&2; exit 1; }
offline="$(cd -- "$2" && pwd -P)"
mkdir -p -- "$workspace"
workspace="$(cd -- "$workspace" && pwd -P)"
export STACKCABIN_SMOKE_DIR="$workspace"
export STACKCABIN_OFFLINE_DIR="$offline"
export STACKCABIN_SMOKE_COMPONENTS='node,caddy,php,cacert,composer,pnpm,yarn,mariadb,postgres'
unset STACKCABIN_SMOKE_BRANCHES STACKCABIN_PUBLISHER_CACHE
"$binary" 2>&1 | tee "$workspace/acceptance.log"
echo "PASS managed runtime acceptance. Evidence retained at $workspace"
