use crate::{
    database::DatabaseManager,
    models::*,
    runtime::{directory_size, extract_archive, EventSink},
    store::{atomic_write, safe_relative},
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    schema_version: u32,
    id: String,
    created_at: String,
    project: ProjectSpec,
    files: BTreeMap<String, String>,
    has_database: bool,
}
pub struct BackupManager {
    root: PathBuf,
    database: Arc<DatabaseManager>,
    sink: EventSink,
}
impl BackupManager {
    pub fn new(root: PathBuf, database: Arc<DatabaseManager>, sink: EventSink) -> Self {
        Self {
            root,
            database,
            sink,
        }
    }
    pub fn list(&self) -> Result<Vec<BackupInfo>> {
        let mut result = vec![];
        for entry in std::fs::read_dir(self.root.join("backups"))? {
            let path = entry?.path();
            if path.extension().is_none_or(|e| e != "zip") {
                continue;
            }
            if let Ok(manifest) = read_manifest(&path) {
                result.push(BackupInfo {
                    id: manifest.id,
                    project_name: manifest.project.name,
                    created_at: manifest.created_at,
                    bytes: std::fs::metadata(&path)?.len(),
                    path: path.to_string_lossy().into(),
                    has_database: manifest.has_database,
                });
            }
        }
        result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(result)
    }
    pub async fn create(&self, project: &Project, operation: &str) -> Result<BackupInfo> {
        let id = uuid::Uuid::new_v4().to_string();
        let staging = self.root.join("staging").join(&id);
        std::fs::create_dir(&staging)?;
        let result: Result<BackupInfo> = async {
            let database = project.spec.database.is_some();
            if database {
                (self.sink)(event(
                    "progress",
                    operation,
                    &project.id,
                    "Taking a consistent database snapshot",
                    Some(10.0),
                ));
                self.database
                    .dump(project, &staging.join("database.dump"))
                    .await?;
            }
            (self.sink)(event(
                "progress",
                operation,
                &project.id,
                "Archiving project files; secrets and dependencies are excluded",
                Some(35.0),
            ));
            let path = self.root.join("backups").join(format!("{id}.zip"));
            let temporary = self.root.join("staging").join(format!("{id}.part"));
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&temporary)?);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(0o600);
            let root = Path::new(&project.path).canonicalize()?;
            let app_root = self.root.canonicalize()?;
            let mut hashes = BTreeMap::new();
            let mut total = 0u64;
            let entries = walkdir::WalkDir::new(&root)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| {
                    if entry.path() == root {
                        return true;
                    }
                    !entry.path().starts_with(&app_root)
                        && !excluded(&entry.file_name().to_string_lossy())
                        && !entry.file_type().is_symlink()
                });
            for entry in entries {
                let entry = entry?;
                if !entry.file_type().is_file() {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(&root)?
                    .to_string_lossy()
                    .replace('\\', "/");
                if project.spec.database.as_ref().is_some_and(|b| {
                    matches!(b.engine, DatabaseEngine::Sqlite) && relative == b.name
                }) {
                    continue;
                }
                let name = format!("project/{relative}");
                safe_relative(&name)?;
                total += entry.metadata()?.len();
                anyhow::ensure!(
                    total < 12 * 1024 * 1024 * 1024,
                    "Backup exceeds 12 GiB safety limit"
                );
                writer.start_file(&name, options)?;
                if relative == "stackcabin.json" {
                    let bytes = serde_json::to_vec_pretty(&sanitized_spec(&project.spec))?;
                    writer.write_all(&bytes)?;
                    hashes.insert(name, hex::encode(Sha256::digest(&bytes)));
                } else {
                    hashes.insert(
                        name,
                        copy_hashed(std::fs::File::open(entry.path())?, &mut writer)?,
                    );
                }
            }
            if database {
                writer.start_file("database.dump", options)?;
                hashes.insert(
                    "database.dump".into(),
                    copy_hashed(
                        std::fs::File::open(staging.join("database.dump"))?,
                        &mut writer,
                    )?,
                );
            }
            let backup_spec = sanitized_spec(&project.spec);
            let manifest = BackupManifest {
                schema_version: 1,
                id: id.clone(),
                created_at: chrono::Utc::now().to_rfc3339(),
                project: backup_spec,
                files: hashes,
                has_database: database,
            };
            writer.start_file("backup.json", options)?;
            writer.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
            writer.finish()?.sync_all()?;
            std::fs::rename(&temporary, &path)?;
            Ok(BackupInfo {
                id,
                project_name: project.spec.name.clone(),
                created_at: manifest.created_at,
                bytes: std::fs::metadata(&path)?.len(),
                path: path.to_string_lossy().into(),
                has_database: database,
            })
        }
        .await;
        let _ = std::fs::remove_dir_all(staging);
        result
    }
    pub async fn restore(
        &self,
        archive: &Path,
        destination: &Path,
        trusted: bool,
    ) -> Result<ProjectSpec> {
        anyhow::ensure!(
            !destination.exists(),
            "Restore into a new folder; existing projects are never overwritten"
        );
        let staging = self
            .root
            .join("staging")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&staging)?;
        let mut destination_owned = false;
        let result: Result<ProjectSpec> = async {
            let manifest = read_manifest(archive)?;
            anyhow::ensure!(manifest.schema_version == 1, "Unsupported backup schema");
            crate::project::validate_spec(&manifest.project)?;
            extract_archive(archive, &staging, "zip", 0)?;
            for (relative, expected) in &manifest.files {
                let path = staging.join(safe_relative(relative)?);
                crate::runtime::verify_checksum(&path, expected)?;
            }
            let project_files = staging.join("project");
            anyhow::ensure!(project_files.is_dir(), "Backup has no project files");
            // Reject files omitted from the integrity manifest before any destination is written.
            for entry in walkdir::WalkDir::new(&project_files) {
                let entry = entry?;
                if entry.file_type().is_file() {
                    let key = entry
                        .path()
                        .strip_prefix(&staging)?
                        .to_string_lossy()
                        .replace('\\', "/");
                    anyhow::ensure!(
                        manifest.files.contains_key(&key),
                        "Unlisted file in backup: {key}"
                    );
                }
            }
            if manifest.has_database {
                anyhow::ensure!(
                    trusted,
                    "Trust the backup to execute its database restore commands"
                );
                anyhow::ensure!(
                    manifest.files.contains_key("database.dump"),
                    "Database snapshot missing from manifest"
                );
            }
            std::fs::create_dir_all(
                destination
                    .parent()
                    .context("Destination needs a parent directory")?,
            )?;
            (self.sink)(event(
                "progress",
                "",
                "restore",
                "Project files verified",
                Some(75.0),
            ));
            // Reserve the final folder atomically. Never overwrite or clean up a folder
            // another application created while this archive was being verified.
            std::fs::create_dir(destination)?;
            destination_owned = true;
            copy_directory_contents(&project_files, destination)?;
            let mut spec = manifest.project;
            if manifest.has_database {
                let project = Project {
                    id: uuid::Uuid::new_v4().to_string(),
                    path: destination.to_string_lossy().into(),
                    spec: spec.clone(),
                    trusted,
                    created_at: chrono::Utc::now().to_rfc3339(),
                };
                spec.database = Some(
                    self.database
                        .restore(&project, &staging.join("database.dump"))
                        .await?,
                );
                // Preserve the new credential identifier when registering the restored project.
                atomic_write(
                    &destination.join(".stackcabin-restore-id"),
                    project.id.as_bytes(),
                )?;
            }
            atomic_write(
                &destination.join("stackcabin.json"),
                &serde_json::to_vec_pretty(&spec)?,
            )?;
            Ok(spec)
        }
        .await;
        if result.is_err() && destination_owned && destination.exists() {
            let _ = std::fs::remove_dir_all(destination);
        }
        let _ = std::fs::remove_dir_all(staging);
        result
    }
    pub fn export(&self, id: &str, destination: &Path) -> Result<()> {
        let backup = self
            .list()?
            .into_iter()
            .find(|b| b.id == id)
            .context("Backup not found")?;
        anyhow::ensure!(!destination.exists(), "Export destination already exists");
        std::fs::copy(backup.path, destination)?;
        Ok(())
    }
}
fn read_manifest(path: &Path) -> Result<BackupManifest> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    let file = archive.by_name("backup.json")?;
    anyhow::ensure!(
        file.size() < 16 * 1024 * 1024,
        "Backup manifest is too large"
    );
    Ok(serde_json::from_reader(file)?)
}
fn excluded(name: &str) -> bool {
    [
        "node_modules",
        "vendor",
        ".git",
        ".next",
        "dist",
        "target",
        ".aws",
        ".ssh",
        ".stackcabin-restore-id",
        "auth.json",
        ".npmrc",
        ".pypirc",
    ]
    .contains(&name)
        || name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with("-wal")
        || name.ends_with("-shm")
}
fn sanitized_spec(spec: &ProjectSpec) -> ProjectSpec {
    let mut spec = spec.clone();
    spec.environment
        .retain(|key, _| !crate::store::sensitive_key(key));
    spec
}
fn copy_hashed(mut input: impl Read, output: &mut impl Write) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        output.write_all(&buffer[..n])?;
    }
    Ok(hex::encode(hasher.finalize()))
}
fn copy_directory_contents(source: &Path, destination: &Path) -> Result<()> {
    for entry in walkdir::WalkDir::new(source) {
        let entry = entry?;
        let target = destination.join(entry.path().strip_prefix(source)?);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(target)?;
        } else if entry.file_type().is_file() {
            std::fs::copy(entry.path(), target)?;
        }
    }
    let _ = directory_size(destination);
    Ok(())
}
