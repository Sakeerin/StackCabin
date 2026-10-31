use crate::models::{Project, Settings};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct Store {
    connection: Mutex<Connection>,
    pub root: PathBuf,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        for name in [
            "runtimes",
            "downloads",
            "staging",
            "backups",
            "services",
            "logs",
        ] {
            std::fs::create_dir_all(root.join(name))?;
        }
        let connection = Connection::open(root.join("stackcabin.sqlite"))?;
        let schema: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        anyhow::ensure!(
            schema <= 1,
            "This metadata database was created by a newer StackCabin version"
        );
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
            PRAGMA user_version=1; COMMIT;")?;
        Ok(Self {
            connection: Mutex::new(connection),
            root: root.into(),
        })
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        let connection = self.connection.lock().unwrap();
        let mut statement =
            connection.prepare("SELECT payload FROM projects ORDER BY rowid DESC")?;
        let rows = statement.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn project(&self, id: &str) -> Result<Project> {
        let data: String = self
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT payload FROM projects WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .context("Project not found")?;
        Ok(serde_json::from_str(&data)?)
    }
    pub fn save_project(&self, project: &Project) -> Result<()> {
        self.connection.lock().unwrap().execute("INSERT INTO projects(id,path,payload) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET path=excluded.path,payload=excluded.payload", params![project.id,project.path,serde_json::to_string(project)?])?;
        Ok(())
    }
    pub fn forget(&self, id: &str) -> Result<()> {
        self.connection
            .lock()
            .unwrap()
            .execute("DELETE FROM projects WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Settings> {
        let value = self.connection.lock().unwrap().query_row(
            "SELECT payload FROM settings WHERE id=1",
            [],
            |r| r.get::<_, String>(0),
        );
        match value {
            Ok(s) => Ok(serde_json::from_str(&s)?),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Settings::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        anyhow::ensure!(
            ["en", "th"].contains(&settings.language.as_str()),
            "Unsupported language"
        );
        anyhow::ensure!(
            ["light", "dark", "system"].contains(&settings.theme.as_str()),
            "Unsupported theme"
        );
        anyhow::ensure!(
            settings.proxy_port >= 1024,
            "Use an unprivileged proxy port (1024 or higher)"
        );
        self.connection.lock().unwrap().execute("INSERT INTO settings(id,payload) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", [serde_json::to_string(settings)?])?;
        Ok(())
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("File has no parent")?;
    std::fs::create_dir_all(parent)?;
    // Stage beside the destination so publication stays on the same filesystem.
    // The owner removes the staged file on write, sync, and publication errors.
    let mut file = tempfile::Builder::new()
        .prefix(".stackcabin-")
        .suffix(".tmp")
        .tempfile_in(parent)?;
    use std::io::Write;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    persist_file(file.into_temp_path(), path)
        .with_context(|| format!("Could not atomically save {}", path.display()))
}

fn persist_file(temp: tempfile::TempPath, path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
        };

        let deadline = Instant::now() + Duration::from_secs(1);
        let mut temp = temp;
        loop {
            match temp.persist(path) {
                Ok(()) => return Ok(()),
                Err(failed) => {
                    // Readers and scanners can briefly deny replacement. Never delete
                    // the destination to work around a lock or retry other I/O errors.
                    let transient = failed.error.raw_os_error().is_some_and(|code| {
                        matches!(
                            code as u32,
                            ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION
                        )
                    });
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if !transient || remaining.is_zero() {
                        return Err(failed.error);
                    }
                    temp = failed.path;
                    std::thread::sleep(remaining.min(Duration::from_millis(25)));
                }
            }
        }
    }
    #[cfg(not(windows))]
    temp.persist(path).map_err(|failed| failed.error)
}

pub fn safe_relative(path: &str) -> Result<PathBuf> {
    let p = Path::new(path);
    anyhow::ensure!(
        !p.is_absolute() && !path.contains('\\') && !path.contains(':') && !path.contains('\0'),
        "Expected a safe relative path"
    );
    anyhow::ensure!(
        p.components().all(|c| matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )),
        "Path traversal is not allowed"
    );
    Ok(p.into())
}

pub fn within(root: &Path, relative: &str) -> Result<PathBuf> {
    let target = dunce::canonicalize(root.join(safe_relative(relative)?))?;
    anyhow::ensure!(
        target.starts_with(dunce::canonicalize(root)?),
        "Path leaves project directory"
    );
    Ok(target)
}

pub fn sensitive_key(key: &str) -> bool {
    let key = key.to_uppercase();
    [
        "PASSWORD",
        "SECRET",
        "TOKEN",
        "API_KEY",
        "ACCESS_KEY",
        "PRIVATE_KEY",
        "CREDENTIAL",
    ]
    .iter()
    .any(|part| key.contains(part))
        || key.ends_with("_PASS")
        || key.ends_with("_PWD")
}
