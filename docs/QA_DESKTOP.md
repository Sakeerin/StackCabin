# StackCabin QA desktop pack

Internal QA build with a development catalog and matching offline runtime archives.
The application is named **StackCabin QA**, uses executable `stackcabin-qa`,
application identity `dev.stackcabin.qa`, its own default metadata directory and
its own OS credential namespace. The normal StackCabin application keeps its
existing identity and catalog. The QA interface displays an English/Thai banner.

Historical builds checked on 24 October 2026 (their seven-day artifacts have expired):

| Target                  | Build                                                                                                | Artifact                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------- |
| Ubuntu 22.04/24.04 x64  | [Ubuntu QA build](https://github.com/Sakeerin/StackCabin/actions/runs/40075038598)                   | `desktop-qa-ubuntu-22.04`   |
| macOS 14+ Apple Silicon | [ARM QA build job](https://github.com/Sakeerin/StackCabin/actions/runs/40074337734/job/120814387895) | `desktop-qa-macos-15`       |
| macOS 14+ Intel         | [Intel QA build](https://github.com/Sakeerin/StackCabin/actions/runs/40075333416)                    | `desktop-qa-macos-15-intel` |

To create a current pack, rebuild the reviewed native packages and update
`.github/native-test-builds.json`, then run **Verify the combined native
stack** with `package_qa=true`. Supply that successful run ID as `source_run` to
**Build Unix QA desktop installers with offline runtimes**. `target=all` requires
all three producer kits in that same source run; single-platform builds need only
their matching kit. Current macOS jobs use 15 ARM/Intel; macOS 14 execution belongs
on a maintained test machine. Expired/missing archives fail rather than being
replaced with unrelated builds.

Before signing a temporary QA catalog, the combined-stack check hashes both the
runtime and its accompanying publisher source archive. The source must match
the reviewed URL/SHA-256, and provenance must record a passed relocation probe
for the exact component/version. Missing source/provenance, failed probes and
packages above the macOS 14 deployment baseline stop the QA build.
The CI artifact selection lives under `.github` and is copied into acceptance
kits as `NATIVE_BUILD_SELECTIONS.json`; normal desktop resources do not include it.

Use the new Actions run's Artifacts section to download the matching pack.
Baseline execution evidence and remaining certification are recorded in
[the implementation status](https://github.com/Sakeerin/StackCabin/blob/main/docs/IMPLEMENTATION_STATUS.md)
in the source repository.

1. Check the downloaded `.tar.gz` against its `.sha256`, then extract it.
2. Verify the installer against `installers/SHA256SUMS.txt`.
3. Install the QA `.deb` or copy **StackCabin QA.app** from the `.dmg`.
   The AppImage can use `APPIMAGE_EXTRACT_AND_RUN=1` if FUSE is unavailable.
   On Linux, provide the normal desktop/WebKit/credential-store prerequisites.
4. Start StackCabin QA as an ordinary desktop user with the OS credential store
   unlocked. Open **Runtimes → Install from offline pack** and select this pack's
   `offline` folder. Install the desired runtimes using that selection.
5. Create/import and explicitly trust your test project, select its runtime,
   then Start. Test database creation, SQL, backup/restore and tray/Quit using
   `docs/VM_ACCEPTANCE.md` in the source repository as the acceptance checklist.

From the extracted folder, verify installer paths relative to `installers`:

```bash
# Ubuntu
(cd installers && sha256sum -c SHA256SUMS.txt)
# macOS
(cd installers && shasum -a 256 -c SHA256SUMS.txt)
```

The offline folder installs runtimes; arbitrary npm/Composer dependencies need
internet access or a cache prepared for that platform. Native Unix package URLs
in this development catalog are not public download endpoints. Keep this
installer and its matching offline folder together. Project setup currently
downloads when tools are missing, so install tools from Runtimes first.

These installers have no E2E plugins, production signing or macOS notarization.
Check `SOURCE_COMMIT.txt`, `RUNTIME_KIT_SOURCE_COMMIT.txt` and
`CATALOG_SHA256.txt` to identify the exact application and runtime kit.
The pack contains no catalog private key or CI keychain. It is not a certified
public release; clean-machine and upgrade acceptance remain required.
