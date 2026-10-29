use crate::{
    models::*,
    store::{atomic_write, safe_relative},
};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub type EventSink = Arc<dyn Fn(AppEvent) + Send + Sync>;
pub const PLATFORM: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};
pub const ARCH: &str = if cfg!(target_arch = "aarch64") {
    "arm64"
} else {
    "x64"
};

pub fn php_archive_url(url: &str) -> Option<String> {
    let filename = url.strip_prefix("https://downloads.php.net/~windows/releases/")?;
    (filename.starts_with("php-")
        && filename.ends_with(".zip")
        && filename
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ['.', '-'].contains(&character)))
    .then(|| format!("https://downloads.php.net/~windows/releases/archives/{filename}"))
}

fn node_release_alias(url: &str) -> Option<String> {
    let relative = url.strip_prefix("https://nodejs.org/dist/")?;
    let (version, filename) = relative.split_once('/')?;
    let numbers: Vec<_> = version.strip_prefix('v')?.split('.').collect();
    (numbers.len() == 3
        && numbers
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && filename.starts_with(&format!("node-{version}-"))
        && [".zip", ".tar.gz", ".tar.xz"]
            .iter()
            .any(|suffix| filename.ends_with(suffix))
        && filename
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ['.', '-'].contains(&character)))
    .then(|| format!("https://nodejs.org/download/release/{relative}"))
}

async fn download_archive(
    client: &reqwest::Client,
    artifact: &RuntimeArtifact,
    partial: &Path,
    token: &CancellationToken,
    sink: &EventSink,
    operation: &str,
) -> Result<()> {
    let transfer = async {
        for attempt in 0..3 {
            if attempt > 0 {
                (sink)(event(
                    "progress",
                    operation,
                    &artifact.id,
                    format!("Retrying interrupted download ({}/3)", attempt + 1),
                    Some(0.0),
                ));
                tokio::time::sleep(Duration::from_secs(attempt)).await;
            }
            let result: Result<()> = async {
                let url = if attempt > 0 {
                    node_release_alias(&artifact.url).unwrap_or_else(|| artifact.url.clone())
                } else {
                    artifact.url.clone()
                };
                if url != artifact.url {
                    (sink)(event(
                        "progress",
                        operation,
                        &artifact.id,
                        "Downloading the same version from Node.js",
                        Some(0.0),
                    ));
                }
                let mut response = client.get(url).send().await?;
                if matches!(
                    response.status(),
                    reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::GONE
                ) {
                    if let Some(archive) = php_archive_url(&artifact.url) {
                        (sink)(event(
                            "progress",
                            operation,
                            &artifact.id,
                            "Downloading the same version from the official PHP archive",
                            Some(0.0),
                        ));
                        response = client.get(archive).send().await?;
                    }
                }
                let response = response.error_for_status()?;
                let total = response.content_length().unwrap_or(artifact.size).max(1);
                let mut stream = response.bytes_stream();
                // Always restart a failed transfer. Never append unverified bytes.
                let mut file = tokio::fs::File::create(partial).await?;
                let mut received = 0u64;
                use tokio::io::AsyncWriteExt;
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk?;
                    file.write_all(&chunk).await?;
                    received += chunk.len() as u64;
                    anyhow::ensure!(
                        received <= 8 * 1024 * 1024 * 1024,
                        "Runtime download exceeds size limit"
                    );
                    (sink)(event(
                        "progress",
                        operation,
                        &artifact.id,
                        "Downloading runtime",
                        Some((received as f64 / total as f64 * 85.0).min(85.0)),
                    ));
                }
                file.sync_all().await?;
                Ok(())
            }
            .await;
            match result {
                Ok(()) => return Ok(()),
                Err(error) => {
                    let _ = tokio::fs::remove_file(partial).await;
                    let interrupted = error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
                        error.is_timeout()
                            || error.is_connect()
                            || error.is_body()
                            || error.is_decode()
                    });
                    if attempt == 2 || !interrupted {
                        return Err(error);
                    }
                }
            }
        }
        unreachable!()
    };
    // Preserve the original total transfer budget across all attempts. Cancellation
    // also interrupts backoff, waiting for headers, stalled bodies and file writes.
    let result = tokio::select! {
        _ = token.cancelled() => Err(anyhow::anyhow!("Installation cancelled")),
        result = tokio::time::timeout(Duration::from_secs(1800), transfer) =>
            result.unwrap_or_else(|_| Err(anyhow::anyhow!("Runtime download exceeded thirty minutes"))),
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(partial).await;
    }
    result
}

pub struct RuntimeManager {
    pub root: PathBuf,
    pub catalog: Catalog,
    pub catalog_error: Option<String>,
    sink: EventSink,
    operations: crate::operations::Operations,
    install_lock: tokio::sync::Mutex<()>,
}

pub fn verify_catalog(bytes: &[u8], signature: &str, public_key: &str) -> Result<Catalog> {
    let public: [u8; 32] = STANDARD
        .decode(public_key.trim())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid catalog public key"))?;
    let sig = Signature::from_slice(&STANDARD.decode(signature.trim())?)?;
    VerifyingKey::from_bytes(&public)?
        .verify_strict(bytes, &sig)
        .context("Catalog signature is invalid")?;
    let catalog: Catalog = serde_json::from_slice(bytes)?;
    anyhow::ensure!(catalog.schema_version == 1, "Unsupported catalog schema");
    let mut ids = std::collections::HashSet::new();
    for artifact in &catalog.artifacts {
        safe_relative(&artifact.id)?;
        anyhow::ensure!(!artifact.id.contains('/'), "Invalid artifact id");
        anyhow::ensure!(ids.insert(&artifact.id), "Duplicate runtime artifact id");
        anyhow::ensure!(
            artifact.sha256.len() == 64 && hex::decode(&artifact.sha256).is_ok(),
            "Invalid SHA256"
        );
        anyhow::ensure!(
            artifact.url.starts_with("https://"),
            "Runtime source must use HTTPS"
        );
        for executable in artifact.executables.values() {
            safe_relative(executable)?;
        }
    }
    Ok(catalog)
}

impl RuntimeManager {
    pub fn new(root: PathBuf, sink: EventSink) -> Self {
        let result = verify_catalog(
            include_bytes!("../../../runtime-catalog/catalog.json"),
            include_str!("../../../runtime-catalog/catalog.sig"),
            include_str!("../../../runtime-catalog/public-key.txt"),
        );
        let (catalog, error) = match result {
            Ok(catalog) => (catalog, None),
            Err(e) => (
                Catalog {
                    schema_version: 1,
                    generated_at: String::new(),
                    artifacts: vec![],
                },
                Some(format!("{e:#}")),
            ),
        };
        Self {
            root,
            catalog,
            catalog_error: error,
            sink,
            operations: Default::default(),
            install_lock: Default::default(),
        }
    }
    pub fn list(&self) -> Vec<RuntimeInfo> {
        self.catalog
            .artifacts
            .iter()
            .filter(|a| a.platform == PLATFORM && a.arch == ARCH)
            .map(|a| {
                let path = self.root.join("runtimes").join(&a.id);
                let installed = self.receipt_valid(a, &path);
                let disk_bytes = if installed {
                    match std::fs::read_to_string(path.join(".stackcabin-size"))
                        .ok()
                        .and_then(|s| s.parse().ok())
                    {
                        Some(bytes) => bytes,
                        None => {
                            let bytes = directory_size(&path);
                            let _ = atomic_write(
                                &path.join(".stackcabin-size"),
                                bytes.to_string().as_bytes(),
                            );
                            bytes
                        }
                    }
                } else {
                    0
                };
                RuntimeInfo {
                    artifact: a.clone(),
                    installed,
                    path: installed.then(|| path.to_string_lossy().into()),
                    disk_bytes,
                }
            })
            .collect()
    }
    fn receipt_valid(&self, artifact: &RuntimeArtifact, root: &Path) -> bool {
        let receipt = std::fs::read_to_string(root.join(".stackcabin-receipt"));
        receipt.is_ok_and(|r| r == artifact.sha256)
            && artifact
                .executables
                .values()
                .all(|p| root.join(p).is_file())
    }
    pub fn resolve(&self, component: &str, version: &str, tool: &str) -> Result<PathBuf> {
        let artifact = self
            .catalog
            .artifacts
            .iter()
            .find(|a| {
                a.component == component
                    && a.version == version
                    && a.platform == PLATFORM
                    && a.arch == ARCH
            })
            .context(format!(
                "{component} {version} is not in the signed catalog for {PLATFORM}/{ARCH}"
            ))?;
        let root = self.root.join("runtimes").join(&artifact.id);
        anyhow::ensure!(
            self.receipt_valid(artifact, &root),
            "Install {} {} in Runtimes first",
            component,
            version
        );
        let relative = artifact
            .executables
            .get(tool)
            .context(format!("Runtime does not provide {tool}"))?;
        let path = dunce::canonicalize(root.join(relative))?;
        anyhow::ensure!(
            path.starts_with(dunce::canonicalize(&root)?),
            "Executable leaves runtime directory"
        );
        Ok(path)
    }
    pub fn latest_installed(&self, component: &str, tool: &str) -> Result<PathBuf> {
        let runtime = self
            .list()
            .into_iter()
            .find(|r| {
                r.installed
                    && r.artifact.component == component
                    && r.artifact.executables.contains_key(tool)
            })
            .context(format!("Install {component} in Runtimes first"))?;
        self.resolve(component, &runtime.artifact.version, tool)
    }
    pub async fn cancel(&self, operation: &str) {
        self.operations.cancel(operation);
    }
    pub fn begin_shutdown(&self) {
        self.operations.close();
    }
    pub async fn wait_idle(&self) {
        self.operations.wait_idle().await;
    }
    pub async fn install(&self, id: &str, operation: &str, offline: Option<PathBuf>) -> Result<()> {
        let activity = self.operations.begin(operation)?;
        let token = activity.token();
        let artifact = self
            .catalog
            .artifacts
            .iter()
            .find(|a| a.id == id && a.platform == PLATFORM && a.arch == ARCH)
            .context("Runtime not available for this platform")?
            .clone();
        let result = async {
            let _guard = tokio::select! {
                biased;
                _ = token.cancelled() => anyhow::bail!("Installation cancelled"),
                guard = self.install_lock.lock() => guard,
            };
            anyhow::ensure!(!token.is_cancelled(), "Installation cancelled");
            self.install_inner(&artifact, operation, token, offline)
                .await
        }
        .await;
        (self.sink)(event(
            if result.is_ok() { "complete" } else { "error" },
            operation,
            id,
            match &result {
                Ok(()) => "Installed and verified".into(),
                Err(e) => format!("{e:#}"),
            },
            None,
        ));
        result
    }
    async fn install_inner(
        &self,
        artifact: &RuntimeArtifact,
        operation: &str,
        token: &CancellationToken,
        offline: Option<PathBuf>,
    ) -> Result<()> {
        let destination = self.root.join("runtimes").join(&artifact.id);
        if self.receipt_valid(artifact, &destination) {
            return Ok(());
        }
        if destination.exists() {
            let managed_root = self.root.join("runtimes").canonicalize()?;
            anyhow::ensure!(
                destination.canonicalize()?.starts_with(&managed_root),
                "Invalid incomplete runtime path"
            );
            std::fs::remove_dir_all(&destination)
                .context("Could not clear an incomplete runtime installation")?;
        }
        let archive_path = self.root.join("downloads").join(&artifact.sha256);
        let partial = self
            .root
            .join("downloads")
            .join(format!("{}.part", uuid::Uuid::new_v4()));
        let download: Result<()> = async {
            if let Some(folder) = offline {
                let source = folder.join(&artifact.sha256);
                tokio::fs::copy(source, &partial)
                    .await
                    .context("Offline bundle does not contain this runtime")?;
            } else if !archive_path.exists() {
                (self.sink)(event(
                    "progress",
                    operation,
                    &artifact.id,
                    "Downloading runtime",
                    Some(0.0),
                ));
                let client = reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(30))
                    .read_timeout(Duration::from_secs(60))
                    .timeout(Duration::from_secs(1800))
                    .https_only(true)
                    .build()?;
                download_archive(&client, artifact, &partial, token, &self.sink, operation).await?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = download {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(e);
        }
        if token.is_cancelled() {
            let _ = tokio::fs::remove_file(&partial).await;
            anyhow::bail!("Installation cancelled");
        }
        let candidate = if partial.exists() {
            &partial
        } else {
            &archive_path
        };
        if let Err(e) = verify_checksum(candidate, &artifact.sha256) {
            let _ = std::fs::remove_file(candidate);
            return Err(e);
        }
        if partial.exists() {
            if archive_path.exists() {
                std::fs::remove_file(&partial)?;
            } else {
                std::fs::rename(&partial, &archive_path)?;
            }
        }
        (self.sink)(event(
            "progress",
            operation,
            &artifact.id,
            "Verifying and extracting",
            Some(90.0),
        ));
        let staging = self
            .root
            .join("staging")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&staging)?;
        let result: Result<()> = (|| {
            if artifact.archive == "file" {
                let file = artifact
                    .executables
                    .values()
                    .next()
                    .context("File artifact has no destination")?;
                let output = staging.join(safe_relative(file)?);
                std::fs::create_dir_all(output.parent().unwrap())?;
                std::fs::copy(&archive_path, output)?;
            } else {
                extract_archive(
                    &archive_path,
                    &staging,
                    &artifact.archive,
                    artifact.strip_components,
                )
                .context("Runtime archive extraction failed")?;
            }
            anyhow::ensure!(!token.is_cancelled(), "Installation cancelled");
            for relative in artifact.executables.values() {
                let executable = staging.join(relative);
                anyhow::ensure!(executable.is_file(), "Package is missing {relative}");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))?;
                }
            }
            atomic_write(
                &staging.join(".stackcabin-receipt"),
                artifact.sha256.as_bytes(),
            )
            .context("Could not write runtime receipt")?;
            anyhow::ensure!(!destination.exists(), "Runtime directory already exists with an invalid receipt; remove it before reinstalling");
            match std::fs::rename(&staging, &destination) {
                Ok(()) => Ok(()),
                Err(error)
                    if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied =>
                {
                    // Some Windows file scanners hold directory handles without FILE_SHARE_DELETE.
                    // Publish the receipt last so a partially copied package can never resolve as installed.
                    std::fs::create_dir(&destination)?;
                    for entry in walkdir::WalkDir::new(&staging).follow_links(false) {
                        let entry = entry?;
                        let relative = entry.path().strip_prefix(&staging)?;
                        if relative == Path::new(".stackcabin-receipt") {
                            continue;
                        }
                        let output = destination.join(relative);
                        if entry.file_type().is_dir() {
                            std::fs::create_dir_all(&output)?;
                        } else if entry.file_type().is_file() {
                            std::fs::copy(entry.path(), &output)
                                .with_context(|| format!("Could not copy {}", output.display()))?;
                        }
                    }
                    anyhow::ensure!(!token.is_cancelled(), "Installation cancelled");
                    atomic_write(
                        &destination.join(".stackcabin-receipt"),
                        artifact.sha256.as_bytes(),
                    )?;
                    Ok(())
                }
                Err(error) => Err(error).with_context(|| {
                    format!(
                        "Could not commit runtime directory {}",
                        destination.display()
                    )
                }),
            }
        })();
        if staging.exists() {
            let _ = std::fs::remove_dir_all(staging);
        }
        result
    }
    pub fn remove(&self, id: &str, projects: &[Project]) -> Result<()> {
        let _activity = self.operations.enter()?;
        let artifact = self
            .catalog
            .artifacts
            .iter()
            .find(|a| a.id == id && a.platform == PLATFORM && a.arch == ARCH)
            .context("Runtime not found")?;
        anyhow::ensure!(
            !projects.iter().any(|p| p
                .spec
                .runtimes
                .iter()
                .any(|r| r.component == artifact.component && r.version == artifact.version)),
            "This runtime is referenced by a project"
        );
        let root = self.root.join("runtimes").canonicalize()?;
        let path = root.join(&artifact.id);
        if path.exists() {
            anyhow::ensure!(
                path.canonicalize()?.starts_with(&root),
                "Invalid runtime path"
            );
            std::fs::remove_dir_all(path)?;
        }
        Ok(())
    }
    pub fn php_ini(&self, version: &str) -> Result<PathBuf> {
        let php = self.resolve("php", version, "php")?;
        let root = php.parent().unwrap();
        let certificate = self.latest_installed("cacert", "cacert").ok();
        let mut content=String::from("[PHP]\nengine=On\ndate.timezone=UTC\nmemory_limit=512M\nupload_max_filesize=64M\npost_max_size=64M\ndisplay_errors=On\nlog_errors=On\nvariables_order=EGPCS\ncgi.fix_pathinfo=1\n");
        if cfg!(windows) {
            content.push_str(&format!(
                "extension_dir=\"{}/ext\"\n",
                root.to_string_lossy().replace('\\', "/")
            ));
            for extension in [
                "curl",
                "openssl",
                "mbstring",
                "intl",
                "zip",
                "fileinfo",
                "pdo_mysql",
                "pdo_pgsql",
                "pdo_sqlite",
                "sqlite3",
                "gd",
                "sodium",
                "exif",
            ] {
                if root.join(format!("ext/php_{extension}.dll")).exists() {
                    content.push_str(&format!("extension={extension}\n"));
                }
            }
        }
        if let Some(certificate) = certificate {
            let path = certificate.to_string_lossy().replace('\\', "/");
            content.push_str(&format!(
                "curl.cainfo=\"{path}\"\nopenssl.cafile=\"{path}\"\n"
            ));
        }
        let path = self
            .root
            .join("services")
            .join(format!("php-{version}.ini"));
        atomic_write(&path, content.as_bytes())?;
        Ok(path)
    }
}

pub fn verify_checksum(path: &Path, expected: &str) -> Result<()> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let len = file.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        hasher.update(&buffer[..len]);
    }
    anyhow::ensure!(
        hex::encode(hasher.finalize()) == expected.to_lowercase(),
        "SHA256 mismatch; file was not installed"
    );
    Ok(())
}

fn output_path(root: &Path, raw: &Path, strip: usize) -> Result<Option<PathBuf>> {
    let text = raw.to_str().context("Non UTF-8 archive path")?;
    safe_relative(text)?;
    let components: Vec<_> = raw
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .collect();
    if components.len() <= strip {
        return Ok(None);
    }
    let mut result = root.to_path_buf();
    for c in &components[strip..] {
        result.push(c.as_os_str());
    }
    Ok(Some(result))
}

pub fn extract_archive(archive: &Path, root: &Path, format: &str, strip: usize) -> Result<()> {
    const LIMIT: u64 = 12 * 1024 * 1024 * 1024;
    let mut expanded = 0u64;
    match format {
        "zip" => {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
            anyhow::ensure!(zip.len() < 200_000, "Too many archive entries");
            for i in 0..zip.len() {
                let mut file = zip.by_index(i)?;
                anyhow::ensure!(
                    file.unix_mode().unwrap_or(0) & 0o170000 != 0o120000,
                    "Archive symlinks are not allowed"
                );
                let Some(path) = output_path(root, Path::new(file.name()), strip)? else {
                    continue;
                };
                if file.is_dir() {
                    std::fs::create_dir_all(path)?;
                    continue;
                }
                expanded = expanded
                    .checked_add(file.size())
                    .context("Archive size overflow")?;
                anyhow::ensure!(expanded <= LIMIT, "Archive too large");
                std::fs::create_dir_all(path.parent().unwrap())?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .with_context(|| format!("Cannot extract {}", path.display()))?;
                std::io::copy(&mut file, &mut output)
                    .with_context(|| format!("Cannot write {}", path.display()))?;
            }
        }
        "tar.gz" | "tar.xz" => {
            let file = std::fs::File::open(archive)?;
            let reader: Box<dyn Read> = if format == "tar.gz" {
                Box::new(flate2::read::GzDecoder::new(file))
            } else {
                Box::new(xz2::read::XzDecoder::new(file))
            };
            let mut tar = tar::Archive::new(reader);
            let mut count = 0;
            for entry in tar.entries()? {
                count += 1;
                anyhow::ensure!(count < 200_000, "Too many archive entries");
                let mut entry = entry?;
                let kind = entry.header().entry_type();
                // Node's npm/npx symlinks are unnecessary: launch npm-cli.js using the selected Node executable.
                if kind.is_symlink() || kind.is_hard_link() {
                    continue;
                }
                anyhow::ensure!(
                    kind.is_file() || kind.is_dir(),
                    "Special archive entries are not allowed"
                );
                let Some(path) = output_path(root, &entry.path()?, strip)? else {
                    continue;
                };
                if kind.is_dir() {
                    std::fs::create_dir_all(path)?;
                    continue;
                }
                expanded = expanded
                    .checked_add(entry.size())
                    .context("Archive size overflow")?;
                anyhow::ensure!(expanded <= LIMIT, "Archive too large");
                std::fs::create_dir_all(path.parent().unwrap())?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)?;
                std::io::copy(&mut entry, &mut output)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(
                        path,
                        std::fs::Permissions::from_mode(entry.header().mode()? & 0o777),
                    )?;
                }
            }
        }
        "file" => {
            let mut file = std::fs::File::create(root.join("composer.phar"))?;
            let mut input = std::fs::File::open(archive)?;
            std::io::copy(&mut input, &mut file)?;
            file.flush()?;
        }
        _ => anyhow::bail!("Unsupported archive format"),
    }
    Ok(())
}

pub fn directory_size(root: &Path) -> u64 {
    walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

#[cfg(test)]
mod download_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const CONTENT: &[u8] = b"complete verified runtime archive";
    enum Reply {
        Truncated,
        Complete,
        Stalled,
        Missing,
    }

    #[test]
    fn node_alias_preserves_the_exact_official_version_and_filename() {
        for relative in [
            "v24.22.1/node-v24.22.1-darwin-arm64.tar.gz",
            "v22.23.4/node-v22.23.4-win-x64.zip",
        ] {
            assert_eq!(
                node_release_alias(&format!("https://nodejs.org/dist/{relative}")),
                Some(format!("https://nodejs.org/download/release/{relative}"))
            );
        }
        for url in [
            "http://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip",
            "https://nodejs.org.evil.test/dist/v24.22.1/node-v24.22.1-win-x64.zip",
            "https://user@nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip",
            "https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip?token=secret",
            "https://nodejs.org/dist/v24.22.1/node-v22.23.4-win-x64.zip",
            "https://nodejs.org/dist/v24.22.1/../node-v24.22.1-win-x64.zip",
            "https://nodejs.org/dist/v24..1/node-v24..1-win-x64.zip",
            "https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.exe",
        ] {
            assert!(
                node_release_alias(url).is_none(),
                "Unexpected alias for {url}"
            );
        }
    }

    async fn publisher(replies: Vec<Reply>) -> (RuntimeArtifact, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            for reply in replies {
                let (mut connection, _) = listener.accept().await.unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    let byte = connection.read_u8().await.unwrap();
                    header.push(byte);
                    assert!(header.len() < 16384);
                }
                let status = if matches!(reply, Reply::Missing) {
                    "404 Not Found"
                } else {
                    "200 OK"
                };
                connection
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            CONTENT.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                if matches!(reply, Reply::Complete) {
                    connection.write_all(CONTENT).await.unwrap();
                } else {
                    connection.write_all(&CONTENT[..2]).await.unwrap();
                    if matches!(reply, Reply::Stalled) {
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                    }
                }
            }
        });
        let mut artifact = RuntimeManager::new(PathBuf::new(), Arc::new(|_| {}))
            .catalog
            .artifacts[0]
            .clone();
        artifact.url = format!("http://{address}/runtime");
        artifact.sha256 = hex::encode(Sha256::digest(CONTENT));
        (artifact, task)
    }

    fn client() -> reqwest::Client {
        // Local transport fixtures need no TLS certificate. The production caller
        // always supplies its HTTPS-only client, without changing trusted roots.
        reqwest::Client::builder()
            .no_proxy()
            .read_timeout(Duration::from_millis(500))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn truncated_transfer_restarts_without_appending_partial_bytes() {
        let (artifact, server) = publisher(vec![Reply::Truncated, Reply::Complete]).await;
        let root = tempfile::tempdir().unwrap();
        let partial = root.path().join("runtime.part");
        let sink: EventSink = Arc::new(|_| {});
        download_archive(
            &client(),
            &artifact,
            &partial,
            &CancellationToken::new(),
            &sink,
            "test",
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(std::fs::read(&partial).unwrap(), CONTENT);
        verify_checksum(&partial, &artifact.sha256).unwrap();
    }

    #[tokio::test]
    async fn exhausted_transfer_retries_remove_partial_bytes() {
        let (artifact, server) =
            publisher(vec![Reply::Truncated, Reply::Truncated, Reply::Truncated]).await;
        let root = tempfile::tempdir().unwrap();
        let partial = root.path().join("runtime.part");
        let sink: EventSink = Arc::new(|_| {});
        assert!(download_archive(
            &client(),
            &artifact,
            &partial,
            &CancellationToken::new(),
            &sink,
            "test"
        )
        .await
        .is_err());
        server.await.unwrap();
        assert!(!partial.exists());
    }

    #[tokio::test]
    async fn missing_artifact_is_not_retried_as_a_transfer_error() {
        let (artifact, server) = publisher(vec![Reply::Missing]).await;
        let root = tempfile::tempdir().unwrap();
        let partial = root.path().join("runtime.part");
        let sink: EventSink = Arc::new(|_| {});
        let error = download_archive(
            &client(),
            &artifact,
            &partial,
            &CancellationToken::new(),
            &sink,
            "test",
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<reqwest::Error>().unwrap().status(),
            Some(reqwest::StatusCode::NOT_FOUND)
        );
        server.await.unwrap();
        assert!(!partial.exists());
    }

    #[tokio::test]
    async fn stalled_body_times_out_and_retries_the_transfer() {
        let (artifact, server) = publisher(vec![Reply::Stalled, Reply::Complete]).await;
        let root = tempfile::tempdir().unwrap();
        let partial = root.path().join("runtime.part");
        let sink: EventSink = Arc::new(|_| {});
        tokio::time::timeout(
            Duration::from_secs(6),
            download_archive(
                &client(),
                &artifact,
                &partial,
                &CancellationToken::new(),
                &sink,
                "test",
            ),
        )
        .await
        .unwrap()
        .unwrap();
        server.await.unwrap();
        verify_checksum(&partial, &artifact.sha256).unwrap();
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_body_and_removes_partial_bytes() {
        let (artifact, server) = publisher(vec![Reply::Stalled]).await;
        let root = tempfile::tempdir().unwrap();
        let partial = root.path().join("runtime.part");
        let token = CancellationToken::new();
        let cancel = token.clone();
        let sink: EventSink = Arc::new(move |event| {
            if event.progress.is_some_and(|value| value > 0.0) {
                cancel.cancel();
            }
        });
        let error = tokio::time::timeout(
            Duration::from_secs(6),
            download_archive(&client(), &artifact, &partial, &token, &sink, "test"),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(error.to_string().contains("Installation cancelled"));
        assert!(!partial.exists());
        server.await.unwrap();
    }
}
