use crate::{
    models::*,
    process::{available_port, Supervisor},
    runtime::RuntimeManager,
    store::atomic_write,
};
use anyhow::{Context, Result};
use rand::RngCore;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tokio::{io::AsyncWriteExt, process::Command, sync::Mutex};

pub struct DatabaseManager {
    root: PathBuf,
    runtime: Arc<RuntimeManager>,
    supervisor: Arc<Supervisor>,
    ports: Mutex<BTreeMap<String, u16>>,
    transition: Mutex<()>,
    postgres_alias: std::sync::OnceLock<std::result::Result<PathBuf, String>>,
    #[cfg(unix)]
    mariadb_socket: std::sync::OnceLock<std::result::Result<tempfile::TempDir, String>>,
}
type ClientCommand = (
    PathBuf,
    Vec<String>,
    BTreeMap<String, String>,
    Option<SecretFile>,
);
impl DatabaseManager {
    pub fn new(root: PathBuf, runtime: Arc<RuntimeManager>, supervisor: Arc<Supervisor>) -> Self {
        let ports = std::fs::read(root.join("services/ports.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            root,
            runtime,
            supervisor,
            ports: Mutex::new(ports),
            transition: Mutex::new(()),
            postgres_alias: Default::default(),
            #[cfg(unix)]
            mariadb_socket: Default::default(),
        }
    }
    pub async fn list(&self) -> Vec<ServiceInfo> {
        let runtimes = self.runtime.list();
        let ports = self.ports.lock().await;
        let mut result = vec![];
        for (id, name, default) in [
            ("caddy", "Caddy", 8080),
            ("mariadb", "MariaDB", 3307),
            ("postgres", "PostgreSQL", 5433),
        ] {
            let port = if id == "caddy" {
                self.supervisor.proxy_port().await.unwrap_or(default)
            } else {
                *ports.get(id).unwrap_or(&default)
            };
            result.push(ServiceInfo {
                id: id.into(),
                name: name.into(),
                state: self.supervisor.service_state(id).await,
                port,
                installed: runtimes
                    .iter()
                    .any(|r| r.installed && r.artifact.component == id),
                detail: if id == "caddy" {
                    "Starts automatically with your projects"
                } else {
                    "Shared server · separate databases per project"
                }
                .into(),
            });
        }
        result
    }
    pub async fn start(&self, engine: &DatabaseEngine) -> Result<u16> {
        let _guard = self.transition.lock().await;
        if matches!(engine, DatabaseEngine::Sqlite) {
            return Ok(0);
        }
        let id = engine_id(engine);
        if self.supervisor.service_state(id).await == ProcessState::Running {
            return Ok(*self
                .ports
                .lock()
                .await
                .get(id)
                .context("Service port unavailable")?);
        }
        let password = credential(&format!("service:{id}"))?;
        let preferred = *self
            .ports
            .lock()
            .await
            .get(id)
            .unwrap_or(&if id == "mariadb" { 3307 } else { 5433 });
        let port = available_port(preferred).await?;
        let directory = self.root.join("services").join(id);
        std::fs::create_dir_all(&directory)?;
        let data = directory.join("data");
        let mut bootstrap_secret = None;
        if id == "postgres" {
            let pg_data = self.postgres_path(&data)?;
            if !data.join("PG_VERSION").exists() {
                let password_file = SecretFile::new(directory.join("init.password"), &password)?;
                let init = self.postgres_program("initdb")?;
                run(
                    &init,
                    &[
                        "-D".into(),
                        pg_data.to_string_lossy().into(),
                        "-U".into(),
                        "postgres".into(),
                        "--auth=scram-sha-256".into(),
                        "--encoding=UTF8".into(),
                        "--locale=C".into(),
                        format!(
                            "--pwfile={}",
                            self.postgres_path(&password_file.0)?.display()
                        ),
                    ],
                    &BTreeMap::new(),
                    None,
                )
                .await?;
            }
            let executable = self.postgres_program("postgres")?;
            self.supervisor
                .start_service(
                    id,
                    &executable,
                    &[
                        "-D".into(),
                        pg_data.to_string_lossy().into(),
                        "-h".into(),
                        "127.0.0.1".into(),
                        "-p".into(),
                        port.to_string(),
                        "-c".into(),
                        "unix_socket_directories=".into(),
                    ],
                    &BTreeMap::new(),
                    port,
                )
                .await?;
        } else {
            if !data.join("mysql").exists() {
                let init = self.runtime.latest_installed(id, "install-db")?;
                let mut args = vec![format!("--datadir={}", data.display())];
                if !cfg!(windows) {
                    args.extend([
                        "--auth-root-authentication-method=normal".into(),
                        "--skip-test-db".into(),
                    ]);
                }
                run(&init, &args, &BTreeMap::new(), None).await?;
            }
            let init_sql=format!("ALTER USER 'root'@'localhost' IDENTIFIED BY '{password}';\nCREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '{password}';\nALTER USER 'root'@'127.0.0.1' IDENTIFIED BY '{password}';\nGRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;\n");
            let init_file = SecretFile::new(directory.join("init.sql"), &init_sql)?;
            let init_path = init_file.0.clone();
            bootstrap_secret = Some(init_file);
            let executable = self.runtime.latest_installed(id, "mariadbd")?;
            let args = vec![
                "--no-defaults".into(),
                format!("--datadir={}", data.display()),
                format!("--port={port}"),
                "--bind-address=127.0.0.1".into(),
                "--skip-name-resolve".into(),
                format!("--init-file={}", init_path.display()),
            ];
            #[cfg(unix)]
            let args = {
                // A private, short socket path avoids other database instances and
                // macOS's Unix socket length limit, including Unicode app paths.
                let socket = self.mariadb_socket.get_or_init(|| {
                    tempfile::Builder::new()
                        .prefix("sc-db-")
                        .tempdir_in("/tmp")
                        .map_err(|error| error.to_string())
                });
                let socket = socket.as_ref().map_err(|error| anyhow::anyhow!(error))?;
                let mut args = args;
                args.push(format!(
                    "--socket={}",
                    socket.path().join("db.sock").display()
                ));
                args
            };
            self.supervisor
                .start_service(id, &executable, &args, &BTreeMap::new(), port)
                .await?;
        }
        let mut authenticated = false;
        for _ in 0..30 {
            if self.query_admin(engine, port, "SELECT 1;").await.is_ok() {
                authenticated = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        if !authenticated {
            self.supervisor.stop_service(id).await;
            anyhow::bail!("Database started but its managed credentials did not authenticate. Check service logs.");
        }
        drop(bootstrap_secret);
        let mut ports = self.ports.lock().await;
        ports.insert(id.into(), port);
        atomic_write(
            &self.root.join("services/ports.json"),
            &serde_json::to_vec(&*ports)?,
        )?;
        Ok(port)
    }
    pub async fn provision(
        &self,
        project: &Project,
        engine: DatabaseEngine,
    ) -> Result<DatabaseBinding> {
        anyhow::ensure!(
            project.trusted,
            "Trust this project before creating a database"
        );
        let suffix = project.id.replace('-', "");
        let name = format!("sc_{}", &suffix[..20]);
        if matches!(engine, DatabaseEngine::Sqlite) {
            let path = Path::new(&project.path).join("storage/stackcabin.sqlite");
            std::fs::create_dir_all(path.parent().unwrap())?;
            rusqlite::Connection::open(path)?.execute_batch("PRAGMA journal_mode=WAL;")?;
            return Ok(DatabaseBinding {
                engine,
                name: "storage/stackcabin.sqlite".into(),
                username: String::new(),
                port: 0,
            });
        }
        let port = self.start(&engine).await?;
        let password = credential(&format!("project:{}:{}", project.id, engine_id(&engine)))?;
        validate_identifier(&name)?;
        let binding = DatabaseBinding {
            engine: engine.clone(),
            name: name.clone(),
            username: name.clone(),
            port,
        };
        let sql = if matches!(engine, DatabaseEngine::Postgres) {
            // Identifiers and generated hexadecimal passwords cannot contain SQL metacharacters.
            format!("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{name}') THEN CREATE ROLE {name} LOGIN PASSWORD '{password}'; END IF; END $$;\n")
        } else {
            format!("CREATE DATABASE IF NOT EXISTS `{name}`; CREATE USER IF NOT EXISTS '{name}'@'127.0.0.1' IDENTIFIED BY '{password}'; GRANT ALL ON `{name}`.* TO '{name}'@'127.0.0.1';")
        };
        self.query_admin(&engine, port, &sql).await?;
        if matches!(engine, DatabaseEngine::Postgres) {
            let check = self
                .query_admin(
                    &engine,
                    port,
                    &format!("SELECT 1 FROM pg_database WHERE datname='{name}';"),
                )
                .await?;
            if !check.lines().any(|s| s.trim() == "1") {
                self.query_admin(
                    &engine,
                    port,
                    &format!("CREATE DATABASE {name} OWNER {name};"),
                )
                .await?;
            }
        }
        Ok(binding)
    }
    async fn query_admin(&self, engine: &DatabaseEngine, port: u16, sql: &str) -> Result<String> {
        let binding = DatabaseBinding {
            engine: engine.clone(),
            name: if matches!(engine, DatabaseEngine::Postgres) {
                "postgres"
            } else {
                "mysql"
            }
            .into(),
            username: if matches!(engine, DatabaseEngine::Postgres) {
                "postgres"
            } else {
                "root"
            }
            .into(),
            port,
        };
        let password = credential(&format!("service:{}", engine_id(engine)))?;
        self.query(&binding, &password, sql.as_bytes()).await
    }
    async fn query(&self, binding: &DatabaseBinding, password: &str, sql: &[u8]) -> Result<String> {
        let (program, args, env, _secret) = self.client(binding, password, false)?;
        run(&program, &args, &env, Some(sql)).await
    }
    fn client(
        &self,
        binding: &DatabaseBinding,
        password: &str,
        dump: bool,
    ) -> Result<ClientCommand> {
        let mut env = BTreeMap::new();
        if matches!(binding.engine, DatabaseEngine::Postgres) {
            let tool = if dump { "pg_dump" } else { "psql" };
            let program = self.postgres_program(tool)?;
            env.insert("PGPASSWORD".into(), password.into());
            let mut args = vec![
                "--host=127.0.0.1".into(),
                format!("--port={}", binding.port),
                format!("--username={}", binding.username),
                format!("--dbname={}", binding.name),
                "--no-password".into(),
            ];
            if dump {
                args.extend([
                    "--no-owner".into(),
                    "--no-acl".into(),
                    "--format=plain".into(),
                ]);
            } else {
                args.extend([
                    "-X".into(),
                    "--set=ON_ERROR_STOP=1".into(),
                    "--tuples-only".into(),
                ]);
            }
            Ok((program, args, env, None))
        } else {
            let tool = if dump { "mariadb-dump" } else { "mariadb" };
            let program = self.runtime.latest_installed("mariadb", tool)?;
            let secret = SecretFile::new(
                self.root
                    .join("staging")
                    .join(format!("{}.cnf", uuid::Uuid::new_v4())),
                &format!("[client]\npassword={password}\n"),
            )?;
            let mut args = vec![
                format!("--defaults-file={}", secret.0.display()),
                "--host=127.0.0.1".into(),
                format!("--port={}", binding.port),
                format!("--user={}", binding.username),
            ];
            if dump {
                args.extend([
                    "--single-transaction".into(),
                    "--routines".into(),
                    "--triggers".into(),
                    "--skip-lock-tables".into(),
                ]);
            }
            args.push(binding.name.clone());
            Ok((program, args, env, Some(secret)))
        }
    }
    pub async fn dump(&self, project: &Project, destination: &Path) -> Result<()> {
        let mut binding = project
            .spec
            .database
            .clone()
            .context("No database attached")?;
        if matches!(binding.engine, DatabaseEngine::Sqlite) {
            let source = crate::store::within(Path::new(&project.path), &binding.name)?;
            rusqlite::Connection::open(source)?
                .execute("VACUUM INTO ?1", [destination.to_string_lossy().as_ref()])?;
            return Ok(());
        }
        binding.port = self.start(&binding.engine).await?;
        let password = credential(&format!(
            "project:{}:{}",
            project.id,
            engine_id(&binding.engine)
        ))?;
        let (program, args, env, _secret) = self.client(&binding, &password, true)?;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let mut command = Command::new(program);
        command
            .args(args)
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::from(file))
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let output = command.spawn()?.wait_with_output().await?;
        anyhow::ensure!(
            output.status.success(),
            "Database export failed: {}",
            String::from_utf8_lossy(&output.stderr).replace(&password, "[redacted]")
        );
        Ok(())
    }
    pub async fn restore(&self, project: &Project, source: &Path) -> Result<DatabaseBinding> {
        let engine = project
            .spec
            .database
            .as_ref()
            .context("No database in backup")?
            .engine
            .clone();
        let binding = self.provision(project, engine.clone()).await?;
        if matches!(engine, DatabaseEngine::Sqlite) {
            std::fs::copy(source, Path::new(&project.path).join(&binding.name))?;
        } else {
            let password = credential(&format!("project:{}:{}", project.id, engine_id(&engine)))?;
            let (program, args, env, _secret) = self.client(&binding, &password, false)?;
            let mut command = Command::new(program);
            command
                .args(args)
                .envs(env)
                .stdin(Stdio::from(std::fs::File::open(source)?))
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                command.creation_flags(0x08000000);
            }
            let output = command.spawn()?.wait_with_output().await?;
            anyhow::ensure!(
                output.status.success(),
                "Database restore failed: {}",
                String::from_utf8_lossy(&output.stderr).replace(&password, "[redacted]")
            );
        }
        Ok(binding)
    }
    pub fn connection_environment(&self, project: &Project) -> Result<BTreeMap<String, String>> {
        let Some(db) = &project.spec.database else {
            return Ok(BTreeMap::new());
        };
        if matches!(db.engine, DatabaseEngine::Sqlite) {
            return Ok(BTreeMap::from([
                ("DB_CONNECTION".into(), "sqlite".into()),
                (
                    "DB_DATABASE".into(),
                    Path::new(&project.path)
                        .join(&db.name)
                        .to_string_lossy()
                        .into(),
                ),
            ]));
        }
        let password = credential(&format!("project:{}:{}", project.id, engine_id(&db.engine)))?;
        Ok(BTreeMap::from([
            (
                "DB_CONNECTION".into(),
                if matches!(db.engine, DatabaseEngine::Postgres) {
                    "pgsql"
                } else {
                    "mysql"
                }
                .into(),
            ),
            ("DB_HOST".into(), "127.0.0.1".into()),
            ("DB_PORT".into(), db.port.to_string()),
            ("DB_DATABASE".into(), db.name.clone()),
            ("DB_USERNAME".into(), db.username.clone()),
            ("DB_PASSWORD".into(), password),
        ]))
    }
    pub async fn query_project(&self, project: &Project, sql: &str) -> Result<String> {
        anyhow::ensure!(
            project.trusted,
            "Trust this project before executing database commands"
        );
        anyhow::ensure!(sql.len() <= 1024 * 1024, "SQL command is too large");
        let mut binding = project
            .spec
            .database
            .clone()
            .context("No database attached")?;
        if matches!(binding.engine, DatabaseEngine::Sqlite) {
            let path = crate::store::within(Path::new(&project.path), &binding.name)?;
            let connection = rusqlite::Connection::open(path)?;
            let mut statement = connection.prepare(sql)?;
            if statement.column_count() == 0 {
                drop(statement);
                connection.execute_batch(sql)?;
                return Ok("Command completed".into());
            }
            let columns: Vec<_> = statement
                .column_names()
                .iter()
                .map(|s| s.to_string())
                .collect();
            let mut rows = statement.query([])?;
            let mut result = vec![];
            while result.len() < 200 {
                let Some(row) = rows.next()? else { break };
                let mut values = vec![];
                for i in 0..columns.len() {
                    values.push(match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => serde_json::json!(n),
                        rusqlite::types::ValueRef::Real(n) => serde_json::json!(n),
                        rusqlite::types::ValueRef::Text(text) => {
                            serde_json::json!(String::from_utf8_lossy(text))
                        }
                        rusqlite::types::ValueRef::Blob(blob) => {
                            serde_json::json!(format!("[{} bytes]", blob.len()))
                        }
                    });
                }
                result.push(values);
            }
            return Ok(serde_json::to_string_pretty(
                &serde_json::json!({"columns":columns,"rows":result,"limit":200}),
            )?);
        }
        binding.port = self.start(&binding.engine).await?;
        let password = credential(&format!(
            "project:{}:{}",
            project.id,
            engine_id(&binding.engine)
        ))?;
        self.query(&binding, &password, sql.as_bytes()).await
    }
    pub async fn stop(&self, id: &str) -> Result<()> {
        // PostgreSQL pg_ctl performs a checkpoint; MariaDB receives SHUTDOWN via its authenticated client.
        if self.supervisor.service_state(id).await != ProcessState::Running {
            return Ok(());
        }
        if id == "postgres" {
            let exe = self.postgres_program("pg_ctl")?;
            run(
                &exe,
                &[
                    "stop".into(),
                    "-D".into(),
                    self.postgres_path(&self.root.join("services/postgres/data"))?
                        .to_string_lossy()
                        .into(),
                    "-m".into(),
                    "fast".into(),
                    "-w".into(),
                ],
                &BTreeMap::new(),
                None,
            )
            .await?;
        } else if id == "mariadb" {
            let port = *self
                .ports
                .lock()
                .await
                .get(id)
                .context("Service port missing")?;
            self.query_admin(&DatabaseEngine::Mariadb, port, "SHUTDOWN;")
                .await?;
        }
        self.supervisor.stop_service(id).await;
        Ok(())
    }
    fn postgres_program(&self, tool: &str) -> Result<PathBuf> {
        self.postgres_path(&self.runtime.latest_installed("postgres", tool)?)
    }
    fn postgres_path(&self, path: &Path) -> Result<PathBuf> {
        let alias = self.postgres_alias.get_or_init(|| {
            postgres_compatible_root(&self.root).map_err(|error| format!("{error:#}"))
        });
        let alias = alias.as_ref().map_err(|error| anyhow::anyhow!("{error}"))?;
        Ok(alias.join(
            path.strip_prefix(&self.root)
                .context("PostgreSQL path leaves managed storage")?,
        ))
    }
}

// The upstream Windows binaries pass ANSI paths to their UTF-8 bootstrap SQL.
// A verified junction gives them ASCII paths while all files remain in the chosen data directory.
pub fn postgres_compatible_root(root: &Path) -> Result<PathBuf> {
    #[cfg(windows)]
    if !root.as_os_str().is_ascii() {
        use sha2::{Digest, Sha256};
        let id = hex::encode(Sha256::digest(root.to_string_lossy().as_bytes()));
        for parent in root
            .ancestors()
            .skip(1)
            .filter(|p| p.as_os_str().is_ascii())
        {
            let alias = parent.join(format!(".stackcabin-pg-{}", &id[..20]));
            if alias.exists() {
                anyhow::ensure!(
                    dunce::canonicalize(&alias)? == dunce::canonicalize(root)?,
                    "PostgreSQL compatibility alias points to another folder"
                );
                return Ok(alias);
            }
            if junction::create(root, &alias).is_ok() {
                anyhow::ensure!(
                    dunce::canonicalize(&alias)? == dunce::canonicalize(root)?,
                    "PostgreSQL compatibility alias could not be verified"
                );
                return Ok(alias);
            }
        }
        anyhow::bail!("PostgreSQL requires an ASCII compatibility path on Windows. Choose an ASCII application data folder using STACKCABIN_DATA_DIR, or grant write access to an ASCII parent directory.");
    }
    Ok(root.to_path_buf())
}

pub fn engine_id(engine: &DatabaseEngine) -> &'static str {
    match engine {
        DatabaseEngine::Mariadb => "mariadb",
        DatabaseEngine::Postgres => "postgres",
        DatabaseEngine::Sqlite => "sqlite",
    }
}
pub fn validate_identifier(name: &str) -> Result<()> {
    anyhow::ensure!(
        !name.is_empty()
            && name.len() <= 63
            && name.as_bytes()[0].is_ascii_alphabetic()
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "Invalid database identifier"
    );
    Ok(())
}
fn credential(id: &str) -> Result<String> {
    let entry = keyring::Entry::new("dev.stackcabin.desktop", id)
        .context("OS credential store unavailable")?;
    match entry.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            let password = hex::encode(bytes);
            entry
                .set_password(&password)
                .context("Unlock your OS credential store before using managed databases")?;
            Ok(password)
        }
        Err(error) => Err(anyhow::anyhow!("Unlock your OS credential store: {error}")),
    }
}
struct SecretFile(PathBuf);
impl SecretFile {
    fn new(path: PathBuf, content: &str) -> Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Clean up a secret left by an interrupted operation in our own private service directory.
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        let mut file = options.open(&path)?;
        use std::io::Write;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        Ok(Self(path))
    }
}
impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
async fn run(
    program: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
    input: Option<&[u8]>,
) -> Result<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .envs(env)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take().context("Missing command stdin")?;
        stdin.write_all(input).await?;
        stdin.shutdown().await?;
        drop(stdin);
    }
    let output = child.wait_with_output().await?;
    anyhow::ensure!(
        output.status.success(),
        "{} failed: {}",
        program.file_name().unwrap_or_default().to_string_lossy(),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8_lossy(&output.stdout).into())
}
