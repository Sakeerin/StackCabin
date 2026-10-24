#!/usr/bin/env bash
# Only operates on disposable hosted CI machines and dedicated fixture paths.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && -n "${STACKCABIN_SMOKE_DIR:-}" && -n "${STACKCABIN_QA_KIT_DIR:-}" ]]
[[ ! -e "$STACKCABIN_SMOKE_DIR" && ! -L "$STACKCABIN_SMOKE_DIR" ]]
mkdir -p artifacts
exec > >(tee artifacts/upgrade-acceptance.log) 2>&1
if [[ "$RUNNER_OS" == Linux ]]; then
  mkdir -p "$XDG_DATA_HOME"
  printf '%s\n' 'stackcabin-ci-only' | gnome-keyring-daemon --unlock --components=secrets
fi
target/debug/examples/native-smoke
target/debug/examples/persistence-smoke record
cp "$STACKCABIN_SMOKE_DIR/preservation-baseline.json" artifacts/preservation-baseline.json
target/debug/examples/persistence-smoke verify

if [[ "$RUNNER_OS" == Linux ]]; then
  previous=("$STACKCABIN_QA_KIT_DIR/installers/deb/"*.deb)
  candidate=(target/release/bundle/deb/*.deb)
  [[ ${#previous[@]} -eq 1 && ${#candidate[@]} -eq 1 ]]
  package="$(dpkg-deb -f "${previous[0]}" Package)"
  [[ "$package" == *-qa && "$(dpkg-deb -f "${candidate[0]}" Package)" == "$package" ]]
  [[ "$(dpkg-deb -f "${previous[0]}" Version)" == 0.1.0 && "$(dpkg-deb -f "${candidate[0]}" Version)" == 0.1.1 ]]
  sudo dpkg -i "${previous[0]}"
  python scripts/smoke-packaged-unix.py /usr/bin/stackcabin-qa --data-directory "$STACKCABIN_SMOKE_DIR/app-data"
  target/debug/examples/persistence-smoke verify
  sudo dpkg -i "${candidate[0]}"
  [[ "$(dpkg-query -W -f='${Version}' "$package")" == 0.1.1 ]]
  python scripts/smoke-packaged-unix.py /usr/bin/stackcabin-qa --data-directory "$STACKCABIN_SMOKE_DIR/app-data"
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
  install_dmg "${previous[0]}" 0.1.0
  python scripts/smoke-packaged-unix.py "$destination/Contents/MacOS/stackcabin-qa" --data-directory "$STACKCABIN_SMOKE_DIR/app-data"
  target/debug/examples/persistence-smoke verify
  mv "$destination" "$destination.previous"
  install_dmg "${candidate[0]}" 0.1.1
  python scripts/smoke-packaged-unix.py "$destination/Contents/MacOS/stackcabin-qa" --data-directory "$STACKCABIN_SMOKE_DIR/app-data"
fi
target/debug/examples/persistence-smoke verify
echo 'PASS actual QA 0.1.0 -> unpublished 0.1.1 package replacement preserves all real fixture data'
