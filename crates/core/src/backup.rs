use crate::{
    database::DatabaseManager,
    models::*,
    runtime::{extract_archive, EventSink, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_ENTRIES},
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
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024 - 1;

#[derive(Clone, Copy)]
struct BackupLimits {
    bytes: u64,
    entries: usize,
    manifest_bytes: u64,
}

impl Default for BackupLimits {
    fn default() -> Self {
        Self {
            bytes: MAX_ARCHIVE_BYTES,
            entries: MAX_ARCHIVE_ENTRIES,
            manifest_bytes: MAX_MANIFEST_BYTES,
        }
    }
}

struct BackupBudget {
    limits: BackupLimits,
    bytes: u64,
    entries: usize,
}

impl BackupBudget {
    fn new(limits: BackupLimits) -> Self {
        Self {
            limits,
            bytes: 0,
            entries: 0,
        }
    }

    fn entry(&mut self) -> Result<()> {
        anyhow::ensure!(
            self.entries < self.limits.entries,
            "Backup has too many archive entries"
        );
        self.entries += 1;
        Ok(())
    }

    fn add_bytes(&mut self, count: u64) -> Result<()> {
        self.bytes = self.total_with(count)?;
        Ok(())
    }

    fn total_with(&self, count: u64) -> Result<u64> {
        let total = self
            .bytes
            .checked_add(count)
            .context("Backup size overflow")?;
        anyhow::ensure!(
            total <= self.limits.bytes,
            "Backup exceeds the expanded archive size limit"
        );
        Ok(total)
    }
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
        self.create_with_limits(project, operation, BackupLimits::default())
            .await
    }
    async fn create_with_limits(
        &self,
        project: &Project,
        operation: &str,
        limits: BackupLimits,
    ) -> Result<BackupInfo> {
        let id = uuid::Uuid::new_v4().to_string();
        let staging = tempfile::Builder::new()
            .prefix("backup-")
            .tempdir_in(self.root.join("staging"))?;
        async {
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
                    .dump(project, &staging.path().join("database.dump"))
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
            let mut temporary = tempfile::NamedTempFile::new_in(staging.path())?;
            let mut writer = zip::ZipWriter::new(temporary.as_file_mut());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(0o600);
            let root = Path::new(&project.path).canonicalize()?;
            let app_root = self.root.canonicalize()?;
            let mut hashes = BTreeMap::new();
            let mut budget = BackupBudget::new(limits);
            // Even a project containing only excluded files must restore to a
            // real project folder. This directory counts toward the same entry
            // limit enforced by extraction, just like files and control records.
            budget.entry()?;
            writer.add_directory("project/", options.unix_permissions(0o700))?;
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
                if entry.path() == root {
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
                if entry.file_type().is_dir() {
                    budget.entry()?;
                    writer.add_directory(format!("{name}/"), options.unix_permissions(0o700))?;
                    continue;
                }
                if !entry.file_type().is_file() {
                    continue;
                }
                budget.entry()?;
                let file_options = if matches!(
                    relative.as_str(),
                    "stackcabin.json" | "stackcabin.lock.json"
                ) {
                    // These are app-managed configuration, regenerated on restore.
                    options
                } else {
                    project_file_options(options, &entry.metadata()?)
                };
                writer.start_file(&name, file_options)?;
                if relative == "stackcabin.json" {
                    let bytes = serde_json::to_vec_pretty(&sanitized_spec(&project.spec))?;
                    budget.add_bytes(bytes.len() as u64)?;
                    writer.write_all(&bytes)?;
                    hashes.insert(name, hex::encode(Sha256::digest(&bytes)));
                } else {
                    hashes.insert(
                        name,
                        copy_file_hashed(entry.path(), &mut writer, &mut budget)?,
                    );
                }
            }
            if database {
                budget.entry()?;
                writer.start_file("database.dump", options)?;
                hashes.insert(
                    "database.dump".into(),
                    copy_file_hashed(
                        &staging.path().join("database.dump"),
                        &mut writer,
                        &mut budget,
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
            let bytes = serde_json::to_vec_pretty(&manifest)?;
            anyhow::ensure!(
                bytes.len() as u64 <= limits.manifest_bytes,
                "Backup manifest is too large"
            );
            budget.entry()?;
            budget.add_bytes(bytes.len() as u64)?;
            writer.start_file("backup.json", options)?;
            writer.write_all(&bytes)?;
            writer.finish()?.sync_all()?;
            temporary
                .persist_noclobber(&path)
                .map_err(|error| error.error)
                .context("Could not publish the completed backup")?;
            Ok(BackupInfo {
                id,
                project_name: project.spec.name.clone(),
                created_at: manifest.created_at,
                bytes: std::fs::metadata(&path)?.len(),
                path: path.to_string_lossy().into(),
                has_database: database,
            })
        }
        .await
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
        // Restored file modes may deliberately grant group/other access. Keep
        // their verification workspace owner-only until publication completes.
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(&staging)?;
        }
        #[cfg(not(unix))]
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
        write_new_file(destination, |output| {
            std::io::copy(&mut std::fs::File::open(backup.path)?, output)?;
            Ok(())
        })
    }
}
fn write_new_file(
    destination: &Path,
    write: impl FnOnce(&mut std::fs::File) -> Result<()>,
) -> Result<()> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    // Keep the temporary archive on the destination filesystem. The private
    // directory also cleans up a retained temporary hard link on Unix.
    let staging = tempfile::Builder::new()
        .prefix(".stackcabin-export-")
        .tempdir_in(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(staging.path())?;
    write(temporary.as_file_mut())?;
    temporary.as_file_mut().sync_all()?;
    // The existence check in export is only for an early, readable error.
    // Publication itself must refuse a destination created during the copy.
    temporary
        .persist_noclobber(destination)
        .map_err(|error| error.error)
        .context("Could not publish the completed backup export")?;
    Ok(())
}
fn read_manifest(path: &Path) -> Result<BackupManifest> {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    let file = archive.by_name("backup.json")?;
    anyhow::ensure!(
        file.size() <= MAX_MANIFEST_BYTES,
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
fn project_file_options(
    options: zip::write::SimpleFileOptions,
    metadata: &std::fs::Metadata,
) -> zip::write::SimpleFileOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Preserve ordinary source permissions, never setuid/setgid/sticky bits.
        options.unix_permissions(metadata.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        options
    }
}
fn copy_file_hashed(
    path: &Path,
    output: &mut impl Write,
    budget: &mut BackupBudget,
) -> Result<String> {
    let input = std::fs::File::open(path)?;
    // Fail early for known oversized files. The streaming check remains needed
    // if a source changes or grows after this metadata was read.
    budget.total_with(input.metadata()?.len())?;
    copy_hashed(input, output, budget)
}
fn copy_hashed(
    mut input: impl Read,
    output: &mut impl Write,
    budget: &mut BackupBudget,
) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        budget.add_bytes(n as u64)?;
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backup_fixture() -> (tempfile::TempDir, crate::AppCore, Project) {
        let temp = tempfile::TempDir::new().unwrap();
        let core = crate::AppCore::new(temp.path().join("app"), Arc::new(|_| {})).unwrap();
        let source = temp.path().join("โปรเจกต์ backup ทดสอบ");
        std::fs::create_dir(&source).unwrap();
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            path: source.to_string_lossy().into(),
            spec: crate::project::default_spec("Fixture", Preset::Static),
            trusted: true,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        (temp, core, project)
    }

    fn assert_no_backup(core: &crate::AppCore) {
        assert!(core.backups.list().unwrap().is_empty());
        for directory in ["staging", "backups"] {
            assert_eq!(
                std::fs::read_dir(core.store.root.join(directory))
                    .unwrap()
                    .count(),
                0
            );
        }
    }

    #[tokio::test]
    async fn nested_empty_directories_survive_without_restoring_excluded_trees() {
        let (temp, core, project) = backup_fixture();
        let source = Path::new(&project.path);
        for directory in [
            "uploads ว่าง/nested/deep",
            "logs ว่าง",
            "node_modules/ignored",
            ".git/objects",
            ".ssh/private",
        ] {
            std::fs::create_dir_all(source.join(directory)).unwrap();
        }
        std::fs::write(source.join("readme.txt"), b"keep project content").unwrap();
        std::fs::write(source.join(".env"), b"TOKEN=keep original").unwrap();
        let backup = core.backups.create(&project, "directories").await.unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&backup.path).unwrap()).unwrap();
        for directory in [
            "project/uploads ว่าง/",
            "project/uploads ว่าง/nested/",
            "project/uploads ว่าง/nested/deep/",
            "project/logs ว่าง/",
        ] {
            assert!(zip.by_name(directory).unwrap().is_dir());
        }
        let destination = temp.path().join("กู้คืน empty child directories");
        core.restore(Path::new(&backup.path), &destination, false)
            .await
            .unwrap();
        assert!(destination.join("uploads ว่าง/nested/deep").is_dir());
        assert!(destination.join("logs ว่าง").is_dir());
        assert_eq!(
            std::fs::read(destination.join("readme.txt")).unwrap(),
            b"keep project content"
        );
        for excluded in ["node_modules", ".git", ".ssh", ".env"] {
            assert!(!destination.join(excluded).exists());
            assert!(source.join(excluded).exists());
        }
    }

    #[tokio::test]
    async fn empty_child_directories_share_the_entry_budget_and_retry_cleanly() {
        let (temp, core, project) = backup_fixture();
        std::fs::create_dir_all(Path::new(&project.path).join("empty/nested")).unwrap();
        let result = core
            .backups
            .create_with_limits(
                &project,
                "directory-limit",
                BackupLimits {
                    entries: 3,
                    ..Default::default()
                },
            )
            .await;
        assert!(format!("{:#}", result.unwrap_err()).contains("too many archive entries"));
        assert_no_backup(&core);
        assert!(Path::new(&project.path).join("empty/nested").is_dir());
        let backup = core
            .backups
            .create_with_limits(
                &project,
                "retry",
                BackupLimits {
                    entries: 4,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            zip::ZipArchive::new(std::fs::File::open(&backup.path).unwrap())
                .unwrap()
                .len(),
            4
        );
        let destination = temp.path().join("restored directories");
        core.restore(Path::new(&backup.path), &destination, false)
            .await
            .unwrap();
        assert!(destination.join("empty/nested").is_dir());
    }

    #[tokio::test]
    async fn legacy_v1_backup_without_directory_records_still_restores() {
        let (temp, core, project) = backup_fixture();
        let path = temp.path().join("legacy v1.zip");
        let bytes = b"legacy project bytes";
        let manifest = BackupManifest {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            project: project.spec,
            files: BTreeMap::from([(
                "project/original.txt".into(),
                hex::encode(Sha256::digest(bytes)),
            )]),
            has_database: false,
        };
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default().unix_permissions(0o600);
        writer.start_file("project/original.txt", options).unwrap();
        writer.write_all(bytes).unwrap();
        writer.start_file("backup.json", options).unwrap();
        writer
            .write_all(&serde_json::to_vec_pretty(&manifest).unwrap())
            .unwrap();
        writer.finish().unwrap();
        let destination = temp.path().join("restored legacy");
        let restored = core.restore(&path, &destination, false).await.unwrap();
        assert!(!restored.trusted);
        assert_eq!(
            std::fs::read(destination.join("original.txt")).unwrap(),
            bytes
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                destination
                    .join("original.txt")
                    .metadata()
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_restore_verifies_permissive_files_inside_an_owner_only_staging_directory() {
        use std::{
            os::unix::fs::PermissionsExt,
            sync::atomic::{AtomicBool, Ordering},
        };
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("app");
        let staging = root.join("staging");
        let observed = Arc::new(AtomicBool::new(false));
        let signal = observed.clone();
        let core = crate::AppCore::new(
            root,
            Arc::new(move |event| {
                if event.message == "Project files verified" {
                    let entries: Vec<_> = std::fs::read_dir(&staging)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .collect();
                    assert_eq!(entries.len(), 1);
                    assert_eq!(
                        entries[0].metadata().unwrap().permissions().mode() & 0o777,
                        0o700
                    );
                    assert_eq!(
                        entries[0]
                            .join("project/shared.txt")
                            .metadata()
                            .unwrap()
                            .permissions()
                            .mode()
                            & 0o777,
                        0o777
                    );
                    signal.store(true, Ordering::SeqCst);
                }
            }),
        )
        .unwrap();
        let project = core
            .create(temp.path(), "permissive fixture", Preset::Static, true)
            .unwrap();
        let source = Path::new(&project.path).join("shared.txt");
        std::fs::write(&source, b"verified content").unwrap();
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o777)).unwrap();
        let backup = core.backup(&project.id, "private-staging").await.unwrap();
        let destination = temp.path().join("restored permissive file");
        core.restore(Path::new(&backup.path), &destination, false)
            .await
            .unwrap();
        assert!(observed.load(Ordering::SeqCst));
        assert_eq!(
            std::fs::read(destination.join("shared.txt")).unwrap(),
            b"verified content"
        );
        assert_eq!(
            destination
                .join("shared.txt")
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o777
        );
        assert_eq!(
            std::fs::read_dir(core.store.root.join("staging"))
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_source_modes_and_executable_script_survive_backup_restore_without_links() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (temp, core, project) = backup_fixture();
        let source = Path::new(&project.path);
        std::fs::create_dir(source.join("scripts ทดสอบ")).unwrap();
        let script = source.join("scripts ทดสอบ/run.sh");
        std::fs::write(&script, b"#!/bin/sh\nprintf 'restored executable works'\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let data = source.join("readonly.txt");
        std::fs::write(&data, b"read-only content").unwrap();
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o440)).unwrap();
        std::fs::write(source.join("stackcabin.json"), b"will be sanitized").unwrap();
        std::fs::set_permissions(
            source.join("stackcabin.json"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let outside = temp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"outside files stay outside").unwrap();
        symlink(&outside, source.join("linked directory")).unwrap();
        symlink(outside.join("keep.txt"), source.join("linked file")).unwrap();
        let backup = core.backups.create(&project, "unix-modes").await.unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&backup.path).unwrap()).unwrap();
        assert_eq!(
            zip.by_name("project/scripts ทดสอบ/run.sh")
                .unwrap()
                .unix_mode()
                .unwrap()
                & 0o7777,
            0o755
        );
        assert_eq!(
            zip.by_name("project/readonly.txt")
                .unwrap()
                .unix_mode()
                .unwrap()
                & 0o7777,
            0o440
        );
        assert_eq!(
            zip.by_name("project/stackcabin.json")
                .unwrap()
                .unix_mode()
                .unwrap()
                & 0o7777,
            0o600
        );
        let destination = temp.path().join("กู้คืน executable");
        core.restore(Path::new(&backup.path), &destination, false)
            .await
            .unwrap();
        let restored = destination.join("scripts ทดสอบ/run.sh");
        assert_eq!(
            restored.metadata().unwrap().permissions().mode() & 0o7777,
            0o755
        );
        assert_eq!(
            destination
                .join("readonly.txt")
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o440
        );
        assert_eq!(
            std::fs::read(destination.join("readonly.txt")).unwrap(),
            b"read-only content"
        );
        let output = std::process::Command::new(&restored).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"restored executable works");
        assert!(!destination.join("linked directory").exists());
        assert!(!destination.join("linked file").exists());
        assert_eq!(
            std::fs::read(outside.join("keep.txt")).unwrap(),
            b"outside files stay outside"
        );
    }

    #[test]
    fn streaming_size_limit_counts_actual_chunks_across_files_and_accepts_exact_boundary() {
        let mut budget = BackupBudget::new(BackupLimits {
            bytes: 8,
            ..Default::default()
        });
        let mut output = Vec::new();
        let growing = std::io::Cursor::new(b"abcde").chain(std::io::Cursor::new(b"fghi"));
        assert!(copy_hashed(growing, &mut output, &mut budget).is_err());
        assert_eq!(output, b"abcde");
        assert_eq!(budget.bytes, 5);
        let hash = copy_hashed(std::io::Cursor::new(b"xyz"), &mut output, &mut budget).unwrap();
        assert_eq!(hash, hex::encode(Sha256::digest(b"xyz")));
        assert_eq!(output, b"abcdexyz");
        assert_eq!(budget.bytes, 8);
        assert!(copy_hashed(std::io::Cursor::new(b"!"), &mut output, &mut budget).is_err());
        assert_eq!(output, b"abcdexyz");
    }

    #[tokio::test]
    async fn entry_limit_includes_project_root_and_manifest_and_failed_backup_can_retry() {
        let (temp, core, project) = backup_fixture();
        let source = Path::new(&project.path).join("hello.txt");
        std::fs::write(&source, b"keep my work").unwrap();
        let result = core
            .backups
            .create_with_limits(
                &project,
                "entry-limit",
                BackupLimits {
                    entries: 2,
                    ..Default::default()
                },
            )
            .await;
        assert!(format!("{:#}", result.unwrap_err()).contains("too many archive entries"));
        assert_no_backup(&core);
        assert_eq!(std::fs::read(&source).unwrap(), b"keep my work");
        let backup = core
            .backups
            .create_with_limits(
                &project,
                "retry",
                BackupLimits {
                    entries: 3,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            zip::ZipArchive::new(std::fs::File::open(&backup.path).unwrap())
                .unwrap()
                .len(),
            3
        );
        let destination = temp.path().join("กู้คืน entry limit");
        core.restore(Path::new(&backup.path), &destination, false)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(destination.join("hello.txt")).unwrap(),
            b"keep my work"
        );
    }

    #[tokio::test]
    async fn serialized_project_settings_count_instead_of_source_metadata_length() {
        let (_temp, core, project) = backup_fixture();
        let source = Path::new(&project.path).join("stackcabin.json");
        std::fs::write(&source, b"").unwrap();
        let expanded = serde_json::to_vec_pretty(&sanitized_spec(&project.spec))
            .unwrap()
            .len() as u64;
        let result = core
            .backups
            .create_with_limits(
                &project,
                "settings-limit",
                BackupLimits {
                    bytes: expanded - 1,
                    ..Default::default()
                },
            )
            .await;
        assert!(format!("{:#}", result.unwrap_err()).contains("expanded archive size limit"));
        assert_no_backup(&core);
        assert!(std::fs::read(source).unwrap().is_empty());
    }

    #[tokio::test]
    async fn manifest_size_and_total_archive_size_fail_before_backup_is_published() {
        let (_temp, core, project) = backup_fixture();
        let source = Path::new(&project.path).join("hello.txt");
        std::fs::write(&source, b"hello").unwrap();
        for (limits, expected) in [
            (
                BackupLimits {
                    bytes: 5,
                    ..Default::default()
                },
                "expanded archive size limit",
            ),
            (
                BackupLimits {
                    manifest_bytes: 1,
                    ..Default::default()
                },
                "manifest is too large",
            ),
        ] {
            let result = core
                .backups
                .create_with_limits(&project, "manifest-limit", limits)
                .await;
            assert!(format!("{:#}", result.unwrap_err()).contains(expected));
            assert_no_backup(&core);
            assert_eq!(std::fs::read(&source).unwrap(), b"hello");
        }
        core.backups.create(&project, "retry").await.unwrap();
        assert_eq!(core.backups.list().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn database_snapshot_shares_the_size_budget_without_losing_source_or_retry() {
        let (temp, core, _) = backup_fixture();
        let project = core
            .create(temp.path(), "sqlite budget", Preset::Static, true)
            .unwrap();
        let project = core
            .attach_database(&project.id, DatabaseEngine::Sqlite)
            .await
            .unwrap();
        let binding = project.spec.database.as_ref().unwrap();
        let source = Path::new(&project.path).join(&binding.name);
        let database = rusqlite::Connection::open(&source).unwrap();
        database
            .execute_batch(
                "CREATE TABLE payload(data BLOB); INSERT INTO payload VALUES(zeroblob(32768));",
            )
            .unwrap();
        let project_bytes: u64 = walkdir::WalkDir::new(&project.path)
            .into_iter()
            .map(|entry| entry.unwrap())
            .filter(|entry| {
                entry.file_type().is_file()
                    && entry.path() != source
                    && !excluded(&entry.file_name().to_string_lossy())
            })
            .map(|entry| entry.metadata().unwrap().len())
            .sum();
        assert!(
            project_bytes < 8192,
            "Project files alone must fit this test budget"
        );
        // The fixture uses WAL, so the main file may still be small while its
        // committed pages already exceed the budget. VACUUM INTO must include
        // those pages in the logical snapshot.
        let page_count: u64 = database
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        let page_size: u64 = database
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .unwrap();
        assert!(
            page_count * page_size > 8192,
            "The database snapshot must exceed this test budget"
        );
        let result = core
            .backups
            .create_with_limits(
                &project,
                "snapshot-limit",
                BackupLimits {
                    bytes: 8192,
                    ..Default::default()
                },
            )
            .await;
        assert!(format!("{:#}", result.unwrap_err()).contains("expanded archive size limit"));
        assert_no_backup(&core);
        assert_eq!(
            database
                .query_row("SELECT length(data) FROM payload", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            32768
        );
        let backup = core.backups.create(&project, "retry").await.unwrap();
        let destination = temp.path().join("กู้คืน SQLite budget");
        let restored = core
            .restore(Path::new(&backup.path), &destination, true)
            .await
            .unwrap();
        assert_ne!(restored.id, project.id);
        let restored =
            rusqlite::Connection::open(destination.join(restored.spec.database.unwrap().name))
                .unwrap();
        assert_eq!(
            restored
                .query_row("SELECT length(data) FROM payload", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            32768
        );
    }

    #[tokio::test]
    async fn empty_and_fully_excluded_projects_restore_without_restoring_secrets() {
        for excluded in [false, true] {
            let (temp, core, project) = backup_fixture();
            if excluded {
                std::fs::write(
                    Path::new(&project.path).join(".env"),
                    b"secret=keep original",
                )
                .unwrap();
                std::fs::create_dir(Path::new(&project.path).join("node_modules")).unwrap();
                std::fs::write(
                    Path::new(&project.path).join("node_modules/dependency.js"),
                    b"ignored",
                )
                .unwrap();
            }
            let backup = core
                .backups
                .create_with_limits(
                    &project,
                    "empty",
                    BackupLimits {
                        entries: 2,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            let mut archive =
                zip::ZipArchive::new(std::fs::File::open(&backup.path).unwrap()).unwrap();
            assert_eq!(archive.len(), 2);
            assert!(archive.by_name("project/").unwrap().is_dir());
            let destination = temp.path().join("กู้คืน empty");
            core.restore(Path::new(&backup.path), &destination, false)
                .await
                .unwrap();
            assert!(destination.join("stackcabin.json").is_file());
            assert!(!destination.join(".env").exists());
            assert!(!destination.join("node_modules").exists());
            if excluded {
                assert_eq!(
                    std::fs::read(Path::new(&project.path).join(".env")).unwrap(),
                    b"secret=keep original"
                );
            }
        }
    }

    #[test]
    fn export_publishes_only_completed_bytes_and_cleans_staging() {
        let temp = tempfile::TempDir::new().unwrap();
        let destination = temp.path().join("สำรองข้อมูล complete.zip");
        write_new_file(&destination, |output| {
            output.write_all(b"first half")?;
            assert!(!destination.exists());
            output.write_all(b" and second half")?;
            assert!(!destination.exists());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"first half and second half"
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_export_write_keeps_other_files_and_removes_partial_bytes() {
        let temp = tempfile::TempDir::new().unwrap();
        let destination = temp.path().join("incomplete.zip");
        let other = temp.path().join("user-notes.txt");
        std::fs::write(&other, b"keep my work").unwrap();
        let result = write_new_file(&destination, |output| {
            output.write_all(b"partial archive")?;
            anyhow::bail!("Simulated interrupted copy");
        });
        assert!(result.is_err());
        assert!(!destination.exists());
        assert_eq!(std::fs::read(other).unwrap(), b"keep my work");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn export_preserves_a_destination_created_during_copy() {
        let temp = tempfile::TempDir::new().unwrap();
        let destination = temp.path().join("concurrent.zip");
        let result = write_new_file(&destination, |output| {
            assert!(!destination.exists());
            output.write_all(b"new backup bytes")?;
            // Another application creates the final path after the initial
            // existence check, before StackCabin commits the completed file.
            std::fs::write(&destination, b"other application's file")?;
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(destination).unwrap(),
            b"other application's file"
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
