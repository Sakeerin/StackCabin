#!/usr/bin/env bash
# Only operates on disposable hosted CI machines and dedicated fixture paths.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || {
  echo 'Installer upgrade acceptance requires a disposable GitHub-hosted runner' >&2; exit 1;
}
[[ -n "${STACKCABIN_SMOKE_DIR:-}" && -n "${STACKCABIN_QA_KIT_DIR:-}" ]]
data_location="${STACKCABIN_UPGRADE_DATA_LOCATION:-custom}"
[[ "$data_location" == custom || "$data_location" == default ]]
[[ ! -e "$STACKCABIN_SMOKE_DIR" && ! -L "$STACKCABIN_SMOKE_DIR" ]]
mkdir -p artifacts
exec > >(tee artifacts/upgrade-acceptance.log) 2>&1
echo "Hosted runner: $RUNNER_OS / $RUNNER_ARCH; source: $(git rev-parse HEAD)"
date -u '+Acceptance started: %Y-%m-%dT%H:%M:%SZ'
uname -a
echo "Previous application source: $(cat "$STACKCABIN_QA_KIT_DIR/SOURCE_COMMIT.txt")"
echo "Previous catalog SHA-256: $(cat "$STACKCABIN_QA_KIT_DIR/CATALOG_SHA256.txt")"
application_data="$STACKCABIN_SMOKE_DIR/app-data"
if [[ "$data_location" == default ]]; then
  application_data="$(python - <<'PY'
import os, sys
from pathlib import Path
if sys.platform == 'darwin':
    parent = Path.home() / 'Library/Application Support'
elif sys.platform.startswith('linux'):
    xdg = os.environ.get('XDG_DATA_HOME', '')
    parent = Path(xdg) if xdg and Path(xdg).is_absolute() else Path.home() / '.local/share'
else:
    raise RuntimeError('Unix default-path acceptance requires macOS or Linux')
print(parent / 'dev.stackcabin.qa')
PY
)"
  [[ ! -e "$application_data" && ! -L "$application_data" ]] || { echo 'Default-path acceptance refuses existing application data' >&2; exit 1; }
  mkdir -p "$application_data" "$STACKCABIN_SMOKE_DIR"
  # The real default folder stays physical; only the native harness links to it.
  ln -s "$application_data" "$STACKCABIN_SMOKE_DIR/app-data"
fi
echo "Data location: $data_location; expected physical application data: $application_data"
probe_application() {
  if [[ "$data_location" == default ]]; then
    python scripts/smoke-packaged.py "$1" --data-directory "$application_data" --use-default-data-directory
  else
    python scripts/smoke-packaged.py "$1" --data-directory "$application_data"
  fi
}
installer_hashes() {
  python - "$@" <<'PY'
import hashlib,sys
from pathlib import Path
for name in sys.argv[1:]:
    with Path(name).open('rb') as stream:
        print('Installer SHA-256:', hashlib.file_digest(stream, 'sha256').hexdigest(), name)
PY
}
if [[ "$RUNNER_OS" == Linux ]]; then
  mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}"
  printf '%s\n' 'stackcabin-ci-only' | gnome-keyring-daemon --unlock --components=secrets
fi
target/debug/examples/native-smoke
target/debug/examples/native-smoke record-persistence
cp "$STACKCABIN_SMOKE_DIR/preservation-baseline.json" artifacts/preservation-baseline.json
target/debug/examples/native-smoke verify-persistence

if [[ "$RUNNER_OS" == Linux ]]; then
  previous=("$STACKCABIN_QA_KIT_DIR/installers/deb/"*.deb)
  candidate=(target/release/bundle/deb/*.deb)
  [[ ${#previous[@]} -eq 1 && ${#candidate[@]} -eq 1 ]]
  installer_hashes "${previous[0]}" "${candidate[0]}"
  package="$(dpkg-deb -f "${previous[0]}" Package)"
  [[ "$package" == *-qa && "$(dpkg-deb -f "${candidate[0]}" Package)" == "$package" ]]
  [[ "$(dpkg-deb -f "${previous[0]}" Version)" == 0.1.0 && "$(dpkg-deb -f "${candidate[0]}" Version)" == 0.1.1 ]]
  sudo dpkg -i "${previous[0]}"
  probe_application /usr/bin/stackcabin-qa
  target/debug/examples/native-smoke verify-persistence
  sudo dpkg -i "${candidate[0]}"
  [[ "$(dpkg-query -W -f='${Version}' "$package")" == 0.1.1 ]]
  probe_application /usr/bin/stackcabin-qa
else
  destination="$RUNNER_TEMP/installed upgrade ทดสอบ/StackCabin QA.app"
  mount="$RUNNER_TEMP/upgrade-mount"
  mkdir -p "$(dirname "$destination")" "$mount"
  install_dmg() {
    local image="$1" expected_version="$2"
    hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$image"
    trap 'hdiutil detach "$mount"' EXIT
    local apps=("$mount/"*.app)
    [[ ${#apps[@]} -eq 1 && ! -e "$destination" ]]
    ditto "${apps[0]}" "$destination"
    hdiutil detach "$mount"
    trap - EXIT
    [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$destination/Contents/Info.plist")" == dev.stackcabin.qa ]]
    [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$destination/Contents/Info.plist")" == "$expected_version" ]]
    python scripts/check-macos-bundle.py "$destination"
  }
  previous=("$STACKCABIN_QA_KIT_DIR/installers/dmg/"*.dmg)
  candidate=(target/release/bundle/dmg/*.dmg)
  [[ ${#previous[@]} -eq 1 && ${#candidate[@]} -eq 1 ]]
  installer_hashes "${previous[0]}" "${candidate[0]}"
  install_dmg "${previous[0]}" 0.1.0
  probe_application "$destination/Contents/MacOS/stackcabin-qa"
  target/debug/examples/native-smoke verify-persistence
  mv "$destination" "$destination.previous"
  install_dmg "${candidate[0]}" 0.1.1
  probe_application "$destination/Contents/MacOS/stackcabin-qa"
fi
target/debug/examples/native-smoke verify-persistence
echo "PASS actual QA 0.1.0 -> unpublished 0.1.1 package replacement preserves all real fixture data ($data_location data location)"
