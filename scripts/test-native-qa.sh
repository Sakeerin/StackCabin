#!/usr/bin/env bash
set -euo pipefail
source_script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/Run-StackCabinAcceptance.sh"
upgrade_script="$(dirname -- "$source_script")/verify-qa-upgrade.sh"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/kit" "$fixture/offline"
cp "$source_script" "$fixture/kit/Run-StackCabinAcceptance.sh"
cat > "$fixture/kit/native-smoke" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$STACKCABIN_SMOKE_COMPONENTS" == 'node,caddy,php,cacert,composer,pnpm,yarn,mariadb,postgres' ]]
[[ -z "${STACKCABIN_PUBLISHER_CACHE:-}" && -z "${STACKCABIN_SMOKE_BRANCHES:-}" ]]
[[ -d "$STACKCABIN_OFFLINE_DIR" && -d "$STACKCABIN_SMOKE_DIR" ]]
echo 'Fixture harness invoked'
SH
chmod +x "$fixture/kit/native-smoke"
(cd "$fixture/kit"; if [[ "$(uname -s)" == Darwin ]]; then shasum -a 256 native-smoke; else sha256sum native-smoke; fi) > "$fixture/kit/SHA256SUMS.txt"
run() { bash "$fixture/kit/Run-StackCabinAcceptance.sh" "$1" "$fixture/offline"; }
mkdir "$fixture/existing"
echo 'keep my data' > "$fixture/existing/.hidden"
if run "$fixture/existing"; then echo 'Nonempty workspace was accepted' >&2; exit 1; fi
[[ "$(cat "$fixture/existing/.hidden")" == 'keep my data' ]]
ln -s "$fixture/existing" "$fixture/link"
if run "$fixture/link"; then echo 'Symlink workspace was accepted' >&2; exit 1; fi
STACKCABIN_PUBLISHER_CACHE=foreign STACKCABIN_SMOKE_BRANCHES=foreign run "$fixture/clean ทดสอบ"
grep -q 'Fixture harness invoked' "$fixture/clean ทดสอบ/acceptance.log"
echo '# corrupted' >> "$fixture/kit/native-smoke"
if run "$fixture/unreached"; then echo 'Corrupted binary was executed' >&2; exit 1; fi
[[ ! -e "$fixture/unreached" ]]
echo 'PASS Unix acceptance wrapper: isolation, hidden data, symlink and checksum checks'

for location in custom default; do
  if output="$(GITHUB_ACTIONS=false RUNNER_ENVIRONMENT=github-hosted STACKCABIN_UPGRADE_DATA_LOCATION="$location" bash "$upgrade_script" 2>&1)"; then
    echo 'Local installer upgrade execution was accepted' >&2; exit 1
  fi
  [[ "$output" == *'requires a disposable GitHub-hosted runner'* ]]
  if output="$(GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=self-hosted STACKCABIN_UPGRADE_DATA_LOCATION="$location" bash "$upgrade_script" 2>&1)"; then
    echo 'Self-hosted installer upgrade execution was accepted' >&2; exit 1
  fi
  [[ "$output" == *'requires a disposable GitHub-hosted runner'* ]]
done
echo 'PASS Unix installer upgrades refuse local and self-hosted execution in both data modes'
