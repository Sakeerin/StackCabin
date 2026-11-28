# Find a usable development installer

Actions artifacts are temporary downloads, not permanent releases. A successful
historical run can have no downloadable files after its seven-day retention ends.
Open the **Build and verify development installers** workflow in GitHub, select a
successful recent run and check that the artifact for your platform is present.
You need a GitHub account to download Actions artifacts in the browser.

Contributors with Node.js and an authenticated [GitHub CLI](https://cli.github.com/)
can discover the latest available complete producer from a checkout:

```sh
node .github/scripts/preview-installers.mjs
```

Use `--target=windows-x64`, `--target=linux-x64`, `--target=macos-arm64` or
`--target=macos-x64` to find one platform. The default `all` requires all four
artifacts from the same run. `--run-id=<id>` inspects only that exact producer;
it never falls back to another run. `--repository=owner/repo` explicitly selects
another repository; discovery always requires its main branch and its own code.

The JSON report records the source commit, artifact IDs, ZIP SHA-256 values,
expiry times, browser links and argument arrays for `gh run download`. It checks
the producer's workflow, successful completion, repository identity and artifact
provenance. Expired/deleted artifacts and those expiring within fifteen minutes
are unavailable. Discovery considers at most sixty recent successful producers.
Transient connection failures and HTTP 500, 502, 503 or 504 retry the same
metadata request up to twice. If those attempts fail, discovery stops. Authentication
errors, rate limits and malformed JSON stop discovery on the first response.

This command reads metadata only. For browser ZIP downloads, compare the actual
ZIP's SHA-256 with `archiveSha256`, then extract it into a new folder. The reported
`gh run download` command extracts automatically. In either case, verify the
included `SHA256SUMS.txt` against the installers. Contributors can use the same
read-only verifier as CI:

```sh
python scripts/verify-installer-checksums.py installers/windows-x64 --platform Windows
```

Use `Linux` or `macOS` for the other platform folders. The artifact report does
not verify downloaded bytes, sign software or certify a clean machine. Installer
certificates and production acceptance remain separate release gates.

If no matching producer is available, run **Build and verify development
installers** again. Select `all` to supply every platform, wait for all packaging
and startup checks to succeed, then rerun discovery. The Windows offline bundle
and hosted installer-consumer workflows perform the same availability check on
their explicitly selected normal producer before downloading. The offline
assembly still independently checks app-source and catalog compatibility.

The Windows offline ZIP comes from **Build and verify the Windows offline
bundle**, which requires a current normal Windows producer. Its full bundle and
verification/installation evidence are separate artifacts with seven-day
retention; the normal-installer discovery command does not select these. Internal
Unix QA desktop packages are also separate from normal preview installers.
