use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Static,
    Php,
    Laravel,
    Node,
    Express,
    Vue,
    React,
    Nest,
    Next,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSelection {
    pub component: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSpec {
    pub name: String,
    pub tool: String,
    pub args: Vec<String>,
    #[serde(default = "dot")]
    pub cwd: String,
    pub port: Option<u16>,
    pub health_path: Option<String>,
}
fn dot() -> String {
    ".".into()
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseEngine {
    Mariadb,
    Postgres,
    Sqlite,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBinding {
    pub engine: DatabaseEngine,
    pub name: String,
    pub username: String,
    pub port: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSpec {
    pub schema_version: u32,
    pub name: String,
    pub preset: Preset,
    pub runtimes: Vec<RuntimeSelection>,
    pub processes: Vec<ProcessSpec>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    pub database: Option<DatabaseBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub path: String,
    pub spec: ProjectSpec,
    pub trusted: bool,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub name: String,
    pub pid: Option<u32>,
    pub state: ProcessState,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub project_id: String,
    pub processes: Vec<ProcessInfo>,
    pub url: Option<String>,
    pub fallback_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArtifact {
    pub id: String,
    pub component: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub url: String,
    pub sha256: String,
    pub archive: String,
    pub strip_components: usize,
    pub executables: BTreeMap<String, String>,
    pub license: String,
    pub source_url: String,
    #[ts(type = "number")]
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub artifact: RuntimeArtifact,
    pub installed: bool,
    pub path: Option<String>,
    #[ts(type = "number")]
    pub disk_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub schema_version: u32,
    pub generated_at: String,
    pub artifacts: Vec<RuntimeArtifact>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub language: String,
    pub theme: String,
    pub close_to_tray: bool,
    pub proxy_port: u16,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "en".into(),
            theme: "light".into(),
            close_to_tray: true,
            proxy_port: 8080,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub id: String,
    pub title: String,
    pub status: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub project_name: String,
    pub created_at: String,
    #[ts(type = "number")]
    pub bytes: u64,
    pub path: String,
    pub has_database: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub id: String,
    pub name: String,
    pub state: ProcessState,
    pub port: u16,
    pub installed: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub projects: Vec<Project>,
    pub statuses: Vec<ProjectStatus>,
    pub runtimes: Vec<RuntimeInfo>,
    pub services: Vec<ServiceInfo>,
    pub backups: Vec<BackupInfo>,
    pub settings: Settings,
    pub platform: String,
    pub arch: String,
    pub data_directory: String,
    pub catalog_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppEvent {
    pub kind: String,
    pub operation_id: String,
    pub subject: String,
    pub message: String,
    pub progress: Option<f64>,
    pub timestamp: String,
}

pub fn event(
    kind: &str,
    operation: &str,
    subject: &str,
    message: impl Into<String>,
    progress: Option<f64>,
) -> AppEvent {
    AppEvent {
        kind: kind.into(),
        operation_id: operation.into(),
        subject: subject.into(),
        message: message.into(),
        progress,
        timestamp: chrono::Utc::now().to_rfc3339(),
    }
}
