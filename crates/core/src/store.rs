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
    let temp = parent.join(format!(".stackcabin-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    use std::io::Write;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    // Windows rename cannot replace an existing file; keep the last good file until the new one is fully written.
    #[cfg(windows)]
    if path.exists() {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
        }
        let from: Vec<_> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
            let error = std::io::Error::last_os_error();
            let _ = std::fs::remove_file(temp);
            return Err(error.into());
        }
        return Ok(());
    }
    std::fs::rename(&temp, path)?;
    Ok(())
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
