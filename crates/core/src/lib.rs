pub mod backup;
pub mod database;
pub mod models;
pub mod process;
pub mod project;
pub mod runtime;
pub mod store;

pub const APPLICATION_ID: &str = if cfg!(feature = "qa") {
    "dev.stackcabin.qa"
} else {
    "dev.stackcabin.desktop"
};

use anyhow::{Context, Result};
use models::*;
use runtime::{EventSink, RuntimeManager};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub struct AppCore {
    pub store: Arc<store::Store>,
    pub runtimes: Arc<RuntimeManager>,
    pub supervisor: Arc<process::Supervisor>,
    pub databases: Arc<database::DatabaseManager>,
    pub backups: backup::BackupManager,
    events: Arc<Mutex<VecDeque<AppEvent>>>,
    sink: EventSink,
}
impl AppCore {
    pub fn new(root: PathBuf, external: EventSink) -> Result<Self> {
        std::fs::create_dir_all(&root)?;
        let root = dunce::canonicalize(root)?;
        let store = Arc::new(store::Store::open(&root)?);
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let ring = events.clone();
        let sink: EventSink = Arc::new(move |event| {
            let mut ring = ring.lock().unwrap();
            if ring.len() >= 2000 {
                ring.pop_front();
            }
            ring.push_back(event.clone());
            drop(ring);
            external(event);
        });
        let runtimes = Arc::new(RuntimeManager::new(root.clone(), sink.clone()));
        let supervisor = Arc::new(process::Supervisor::new(
            root.clone(),
            runtimes.clone(),
            sink.clone(),
        ));
        let databases = Arc::new(database::DatabaseManager::new(
            root.clone(),
            runtimes.clone(),
            supervisor.clone(),
        ));
        let backups = backup::BackupManager::new(root, databases.clone(), sink.clone());
        Ok(Self {
            store,
            runtimes,
            supervisor,
            databases,
            backups,
            events,
            sink,
        })
    }
    pub async fn snapshot(&self) -> Result<Snapshot> {
        Ok(Snapshot {
            qa_mode: cfg!(feature = "qa"),
            projects: self.store.projects()?,
            statuses: self.supervisor.statuses().await,
            runtimes: self.runtimes.list(),
            services: self.databases.list().await,
            backups: self.backups.list()?,
            settings: self.store.settings()?,
            platform: runtime::PLATFORM.into(),
            arch: runtime::ARCH.into(),
            data_directory: self.store.root.to_string_lossy().into(),
            catalog_error: self.runtimes.catalog_error.clone(),
        })
    }
    fn pin(&self, spec: &mut ProjectSpec) {
        for selection in &mut spec.runtimes {
            if let Some(artifact) = self.runtimes.catalog.artifacts.iter().find(|a| {
                a.platform == runtime::PLATFORM
                    && a.arch == runtime::ARCH
                    && a.component == selection.component
                    && (a.version == selection.version
                        || a.version.starts_with(&format!("{}.", selection.version)))
            }) {
                selection.version = artifact.version.clone();
            }
        }
    }
    fn write_lock(&self, project: &Project) -> Result<()> {
        let locks: Vec<_> = project
            .spec
            .runtimes
            .iter()
            .map(|r| serde_json::json!({"component":r.component,"version":r.version}))
            .collect();
        store::atomic_write(
            &Path::new(&project.path).join("stackcabin.lock.json"),
            &serde_json::to_vec_pretty(&serde_json::json!({"schemaVersion":1,"runtimes":locks}))?,
        )
    }
    pub fn import(&self, path: &Path, mut spec: ProjectSpec, trusted: bool) -> Result<Project> {
        self.pin(&mut spec);
        let project = project::register(&self.store, path, spec, trusted)?;
        self.write_lock(&project)?;
        Ok(project)
    }
    pub fn create(
        &self,
        parent: &Path,
        name: &str,
        preset: Preset,
        trusted: bool,
    ) -> Result<Project> {
        let parent = dunce::canonicalize(parent).context("Choose an existing parent directory")?;
        let path = parent.join(name);
        project::create_files(&path, name, &preset)?;
        let mut spec = project::default_spec(name, preset);
        self.pin(&mut spec);
        let project = project::register(&self.store, &path, spec, trusted)?;
        self.write_lock(&project)?;
        Ok(project)
    }
    pub async fn save_project(
        &self,
        id: &str,
        mut spec: ProjectSpec,
        trusted: bool,
    ) -> Result<Project> {
        anyhow::ensure!(
            !self.supervisor.is_active(id).await,
            "Stop the project before changing its settings"
        );
        self.pin(&mut spec);
        project::validate_spec(&spec)?;
        let mut project = self.store.project(id)?;
        project.spec = spec;
        project.trusted = trusted;
        project::write_spec(&project)?;
        self.store.save_project(&project)?;
        self.write_lock(&project)?;
        Ok(project)
    }
    pub async fn start_project(&self, id: &str) -> Result<ProjectStatus> {
        let mut project = self.store.project(id)?;
        if let Some(binding) = project.spec.database.as_mut() {
            let port = self.databases.start(&binding.engine).await?;
            if port != binding.port {
                binding.port = port;
                project::write_spec(&project)?;
                self.store.save_project(&project)?;
            }
        }
        // Credentials are injected into the child environment only, never written into either project manifest.
        project
            .spec
            .environment
            .extend(self.databases.connection_environment(&project)?);
        self.supervisor
            .start(&project, self.store.settings()?.proxy_port)
            .await
    }
    pub async fn prepare(&self, id: &str, operation: &str) -> Result<()> {
        let project = self.store.project(id)?;
        anyhow::ensure!(
            !self.supervisor.is_active(id).await,
            "Stop the project before installing dependencies"
        );
        let root = Path::new(&project.path);
        let result = async {
            if root.join(".stackcabin-laravel-pending").exists() {
                let staging = self
                    .store
                    .root
                    .join("staging")
                    .join(uuid::Uuid::new_v4().to_string());
                let args = vec![
                    "create-project".into(),
                    "laravel/laravel:^12.0".into(),
                    staging.to_string_lossy().into(),
                    "--no-interaction".into(),
                ];
                self.supervisor
                    .run_task(&project, "composer", &args, operation)
                    .await?;
                // Preserve explicit StackCabin configuration while moving the newly generated Laravel tree.
                for entry in std::fs::read_dir(&staging)? {
                    let entry = entry?;
                    let destination = root.join(entry.file_name());
                    if destination.exists() {
                        continue;
                    }
                    move_new_entry(&entry.path(), &destination)?;
                }
                let _ = std::fs::remove_dir_all(staging);
                std::fs::remove_file(root.join(".stackcabin-laravel-pending"))?;
            } else if root.join("composer.json").exists() {
                self.supervisor
                    .run_task(
                        &project,
                        "composer",
                        &["install".into(), "--no-interaction".into()],
                        operation,
                    )
                    .await?;
            }
            if root.join("package.json").exists() {
                let tool = project
                    .spec
                    .processes
                    .iter()
                    .find(|p| ["npm", "pnpm", "yarn"].contains(&p.tool.as_str()))
                    .map(|p| p.tool.as_str())
                    .unwrap_or("npm");
                let args = if tool == "npm" && root.join("package-lock.json").exists() {
                    vec!["ci".into()]
                } else {
                    vec!["install".into()]
                };
                self.supervisor
                    .run_task(&project, tool, &args, operation)
                    .await?;
            }
            Ok(())
        }
        .await;
        (self.sink)(event(
            if result.is_ok() { "complete" } else { "error" },
            operation,
            id,
            match &result {
                Ok(()) => "Dependencies are ready".into(),
                Err(e) => format!("{e:#}"),
            },
            None,
        ));
        result
    }
    pub async fn forget(&self, id: &str) -> Result<()> {
        self.supervisor.stop(id).await?;
        self.store.forget(id)
    }
    pub async fn attach_database(&self, id: &str, engine: DatabaseEngine) -> Result<Project> {
        anyhow::ensure!(
            !self.supervisor.is_active(id).await,
            "Stop the project before changing databases"
        );
        let mut project = self.store.project(id)?;
        anyhow::ensure!(
            project.spec.database.is_none(),
            "This project already has a database"
        );
        project.spec.database = Some(self.databases.provision(&project, engine).await?);
        project::write_spec(&project)?;
        self.store.save_project(&project)?;
        Ok(project)
    }
    pub async fn backup(&self, id: &str, operation: &str) -> Result<BackupInfo> {
        let project = self.store.project(id)?;
        let was_running = self.supervisor.is_active(id).await;
        if was_running {
            self.supervisor.stop(id).await?;
        }
        let result = self.backups.create(&project, operation).await;
        if was_running {
            if let Err(error) = self.start_project(id).await {
                (self.sink)(event(
                    "error",
                    operation,
                    id,
                    format!("Backup finished, but restart failed: {error:#}"),
                    None,
                ));
            }
        }
        result
    }
    pub async fn restore(
        &self,
        archive: &Path,
        destination: &Path,
        trusted: bool,
    ) -> Result<Project> {
        let spec = self.backups.restore(archive, destination, trusted).await?;
        let marker = destination.join(".stackcabin-restore-id");
        if marker.exists() {
            let id = std::fs::read_to_string(&marker)?;
            uuid::Uuid::parse_str(&id)?;
            let project = Project {
                id,
                path: dunce::canonicalize(destination)?.to_string_lossy().into(),
                spec,
                trusted,
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            self.store.save_project(&project)?;
            self.write_lock(&project)?;
            std::fs::remove_file(marker)?;
            Ok(project)
        } else {
            self.import(destination, spec, trusted)
        }
    }
    pub fn logs(&self, subject: Option<&str>) -> Vec<AppEvent> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| subject.is_none_or(|s| e.subject == s))
            .cloned()
            .collect()
    }
    pub fn doctor(&self) -> Vec<Diagnostic> {
        let root = &self.store.root;
        let runtimes = self.runtimes.list();
        vec![
            Diagnostic{id:"platform".into(),title:"Native platform".into(),status:"ok".into(),detail:format!("{}/{} · managed runtimes run locally",runtime::PLATFORM,runtime::ARCH)},
            Diagnostic{id:"storage".into(),title:"Application storage".into(),status:if root.is_dir(){"ok"}else{"error"}.into(),detail:root.to_string_lossy().into()},
            Diagnostic{id:"catalog".into(),title:"Signed runtime catalog".into(),status:if self.runtimes.catalog_error.is_none(){"ok"}else{"error"}.into(),detail:self.runtimes.catalog_error.clone().unwrap_or_else(||format!("{} packages for this platform",runtimes.len()))},
            Diagnostic{id:"runtimes".into(),title:"Installed runtimes".into(),status:if runtimes.iter().any(|r|r.installed){"ok"}else{"warning"}.into(),detail:format!("{} installed. Projects use their selected version, independent of system PATH.",runtimes.iter().filter(|r|r.installed).count())},
            Diagnostic{id:"network".into(),title:"Local access".into(),status:"ok".into(),detail:"Managed Caddy and database services bind to 127.0.0.1. Review imported application scripts before trusting them.".into()},
        ]
    }
    pub async fn open_project(&self, id: &str, target: &str) -> Result<()> {
        let project = self.store.project(id)?;
        let root = dunce::canonicalize(&project.path)?;
        if target == "browser" || target == "loopback" {
            let url = self
                .supervisor
                .statuses()
                .await
                .into_iter()
                .find(|s| s.project_id == id)
                .and_then(|s| {
                    if target == "loopback" {
                        s.fallback_url
                    } else {
                        s.url
                    }
                })
                .context("Start this project first")?;
            return open_external(&url);
        }
        if target == "folder" {
            return open_external(&root.to_string_lossy());
        }
        let mut command = if target == "terminal" {
            #[cfg(windows)]
            {
                std::process::Command::new(
                    Path::new(&std::env::var("WINDIR")?)
                        .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
                )
            }
            #[cfg(target_os = "macos")]
            {
                let mut c = std::process::Command::new("open");
                c.args(["-a", "Terminal"]);
                c.arg(&root);
                c
            }
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                std::process::Command::new("x-terminal-emulator")
            }
        } else if target == "editor" {
            #[cfg(windows)]
            {
                let local = PathBuf::from(std::env::var("LOCALAPPDATA")?)
                    .join("Programs/Microsoft VS Code/Code.exe");
                let system = PathBuf::from(std::env::var("ProgramFiles")?)
                    .join("Microsoft VS Code/Code.exe");
                let exe = if local.exists() { local } else { system };
                anyhow::ensure!(
                    exe.exists(),
                    "Install Visual Studio Code or open the project folder in your editor"
                );
                let mut c = std::process::Command::new(exe);
                c.arg(&root);
                c
            }
            #[cfg(unix)]
            {
                let mut c = std::process::Command::new("code");
                c.arg(&root);
                c
            }
        } else {
            anyhow::bail!("Unsupported open target")
        };
        if target == "terminal" {
            command.envs(self.supervisor.environment(&project)?);
        }
        command.current_dir(root).spawn()?;
        Ok(())
    }
    pub async fn shutdown(&self) {
        for status in self.supervisor.statuses().await {
            let _ = self.supervisor.stop(&status.project_id).await;
        }
        for id in ["mariadb", "postgres"] {
            let _ = self.databases.stop(id).await;
        }
        self.supervisor.shutdown().await;
    }
    pub async fn cancel(&self, id: &str) {
        self.runtimes.cancel(id).await;
        self.supervisor.cancel(id).await;
    }
}

pub fn open_external(value: &str) -> Result<()> {
    #[cfg(windows)]
    {
        std::process::Command::new(Path::new(&std::env::var("WINDIR")?).join("explorer.exe"))
            .arg(value)
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(value).spawn()?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(value).spawn()?;
    }
    Ok(())
}

fn move_new_entry(source: &Path, destination: &Path) -> Result<()> {
    match std::fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied => {
            if source.is_file() {
                std::fs::copy(source, destination)?;
            } else {
                std::fs::create_dir(destination)?;
                for entry in walkdir::WalkDir::new(source).follow_links(false) {
                    let entry = entry?;
                    anyhow::ensure!(
                        !entry.file_type().is_symlink(),
                        "Generated starter contains an unsupported symlink"
                    );
                    let target = destination.join(entry.path().strip_prefix(source)?);
                    if entry.file_type().is_dir() {
                        std::fs::create_dir_all(target)?;
                    } else if entry.file_type().is_file() {
                        std::fs::copy(entry.path(), target)?;
                    }
                }
            }
            Ok(())
        }
        Err(error) => Err(error).context("Could not move generated starter into the project"),
    }
}
