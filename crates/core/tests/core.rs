use stackcabin_core::{models::*, project, runtime, store, AppCore};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    sync::Arc,
};
use tempfile::TempDir;

fn core(temp: &TempDir) -> AppCore {
    AppCore::new(temp.path().join("app-data"), Arc::new(|_| {})).unwrap()
}

#[test]
fn every_starter_can_be_detected_without_executing_code() {
    let temp = TempDir::new().unwrap();
    for preset in [
        Preset::Static,
        Preset::Php,
        Preset::Node,
        Preset::Express,
        Preset::Vue,
        Preset::React,
        Preset::Nest,
        Preset::Next,
    ] {
        let name = format!("project-{preset:?}");
        let path = temp.path().join(&name);
        project::create_files(&path, &name, &preset).unwrap();
        let detected = project::detect(&path).unwrap();
        assert_eq!(detected.preset, preset);
        project::validate_spec(&detected).unwrap();
    }
}
#[test]
fn detect_laravel_with_vite_retains_both_processes() {
    let temp = TempDir::new().unwrap();
    std::fs::write(temp.path().join("artisan"), "").unwrap();
    std::fs::write(
        temp.path().join("package.json"),
        r#"{"scripts":{"dev":"vite"},"devDependencies":{"vite":"^6"}}"#,
    )
    .unwrap();
    let detected = project::detect(temp.path()).unwrap();
    assert_eq!(detected.preset, Preset::Laravel);
    assert_eq!(detected.processes.len(), 2);
    assert_eq!(detected.runtimes.len(), 2);
}
#[test]
fn registration_preserves_unicode_paths_and_source_when_forgotten() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let project = core
        .create(temp.path(), "โปรเจกต์ ทดสอบ", Preset::Node, false)
        .unwrap();
    assert!(!project.trusted);
    assert!(std::path::Path::new(&project.path)
        .join("server.mjs")
        .exists());
    assert!(core
        .import(
            std::path::Path::new(&project.path),
            project.spec.clone(),
            true
        )
        .is_err());
    core.store.forget(&project.id).unwrap();
    assert!(core.store.projects().unwrap().is_empty());
    assert!(std::path::Path::new(&project.path)
        .join("server.mjs")
        .exists());
}
#[test]
fn project_spec_rejects_path_escape_shell_tools_and_reserved_environment() {
    let mut spec = project::default_spec("safe", Preset::Node);
    spec.processes[0].cwd = "../outside".into();
    assert!(project::validate_spec(&spec).is_err());
    spec.processes[0].cwd = ".".into();
    spec.processes[0].tool = "powershell".into();
    assert!(project::validate_spec(&spec).is_err());
    spec.processes[0].tool = "node".into();
    spec.environment.insert("LD_PRELOAD".into(), "evil".into());
    assert!(project::validate_spec(&spec).is_err());
    spec.environment.clear();
    spec.environment
        .insert("pAtH".into(), "other-runtime".into());
    assert!(project::validate_spec(&spec).is_err());
    for path in ["../escape", "/absolute", "C:/escape", "folder\\..\\escape"] {
        assert!(store::safe_relative(path).is_err());
    }
}
#[test]
fn newer_metadata_schema_is_never_downgraded() {
    let temp = TempDir::new().unwrap();
    let db = rusqlite::Connection::open(temp.path().join("stackcabin.sqlite")).unwrap();
    db.execute_batch("PRAGMA user_version=2").unwrap();
    drop(db);
    assert!(store::Store::open(temp.path()).is_err());
}
#[cfg(windows)]
#[test]
fn postgres_compatibility_alias_preserves_unicode_storage() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("ข้อมูล ทดสอบ");
    std::fs::create_dir(&root).unwrap();
    let alias = stackcabin_core::database::postgres_compatible_root(&root).unwrap();
    assert!(alias.as_os_str().is_ascii());
    std::fs::write(alias.join("probe.txt"), "same data").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("probe.txt")).unwrap(),
        "same data"
    );
    assert_eq!(
        stackcabin_core::database::postgres_compatible_root(&root).unwrap(),
        alias
    );
    junction::delete(&alias).unwrap();
    assert!(root.join("probe.txt").exists());
}
#[test]
fn atomic_settings_replacement_retains_valid_json() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("settings.json");
    store::atomic_write(&path, b"{\"one\":1}").unwrap();
    store::atomic_write(&path, b"{\"two\":2}").unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "{\"two\":2}");
}
#[test]
fn signed_catalog_rejects_tampering() {
    let bytes = include_bytes!("../../../runtime-catalog/catalog.json");
    let signature = include_str!("../../../runtime-catalog/catalog.sig");
    let key = include_str!("../../../runtime-catalog/public-key.txt");
    runtime::verify_catalog(bytes, signature, key).unwrap();
    let mut tampered = bytes.to_vec();
    tampered.push(b' ');
    assert!(runtime::verify_catalog(&tampered, signature, key).is_err());
}
#[test]
fn corrupted_archives_and_path_traversal_are_rejected() {
    let temp = TempDir::new().unwrap();
    let archive = temp.path().join("evil.zip");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    writer
        .start_file("../escaped", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"bad").unwrap();
    writer.finish().unwrap();
    let output = temp.path().join("out");
    std::fs::create_dir(&output).unwrap();
    assert!(runtime::extract_archive(&archive, &output, "zip", 0).is_err());
    assert!(!temp.path().join("escaped").exists());
    assert!(runtime::verify_checksum(&archive, &"0".repeat(64)).is_err());
}
#[tokio::test]
async fn untrusted_project_never_executes_and_missing_runtime_never_reports_running() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let project = core
        .create(temp.path(), "not-trusted", Preset::Node, false)
        .unwrap();
    assert!(core
        .start_project(&project.id)
        .await
        .unwrap_err()
        .to_string()
        .contains("Trust"));
    assert!(core.supervisor.statuses().await.is_empty());
    let mut trusted = project.clone();
    trusted.trusted = true;
    core.store.save_project(&trusted).unwrap();
    assert!(core.start_project(&project.id).await.is_err());
    assert!(!core.supervisor.is_active(&project.id).await);
}
#[tokio::test]
async fn sqlite_backup_is_consistent_excludes_secrets_and_restores_into_a_new_project() {
    let temp = TempDir::new().unwrap();
    let core = core(&temp);
    let project = core
        .create(temp.path(), "original", Preset::Static, true)
        .unwrap();
    std::fs::write(
        std::path::Path::new(&project.path).join(".env"),
        "PASSWORD=secret",
    )
    .unwrap();
    let project = core
        .attach_database(&project.id, DatabaseEngine::Sqlite)
        .await
        .unwrap();
    let mut spec = project.spec.clone();
    spec.environment
        .insert("API_TOKEN".into(), "private-value".into());
    spec.environment
        .insert("APP_LABEL".into(), "public-label".into());
    let project = core.save_project(&project.id, spec, true).await.unwrap();
    let db = rusqlite::Connection::open(
        std::path::Path::new(&project.path).join("storage/stackcabin.sqlite"),
    )
    .unwrap();
    db.execute_batch("CREATE TABLE ideas(name TEXT); INSERT INTO ideas VALUES('hello cabin');")
        .unwrap();
    let backup = core.backup(&project.id, "test").await.unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&backup.path).unwrap()).unwrap();
    assert!(zip.by_name("project/.env").is_err());
    assert!(zip.by_name("database.dump").is_ok());
    for file in ["backup.json", "project/stackcabin.json"] {
        let mut content = String::new();
        zip.by_name(file)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert!(!content.contains("private-value"));
        assert!(content.contains("public-label"));
    }
    drop(zip);
    let destination = temp.path().join("restored");
    let restored = core
        .restore(std::path::Path::new(&backup.path), &destination, true)
        .await
        .unwrap();
    assert_ne!(restored.id, project.id);
    assert!(destination.join("index.html").exists());
    assert!(!destination.join(".env").exists());
    let restored_db =
        rusqlite::Connection::open(destination.join("storage/stackcabin.sqlite")).unwrap();
    let name: String = restored_db
        .query_row("SELECT name FROM ideas", [], |r| r.get(0))
        .unwrap();
    assert_eq!(name, "hello cabin");
    assert!(core
        .restore(std::path::Path::new(&backup.path), &destination, true)
        .await
        .is_err());
    assert!(destination.join("index.html").exists());
}

#[tokio::test]
async fn offline_runtime_checksum_failure_and_incomplete_install_are_recoverable() {
    use sha2::{Digest, Sha256};
    let temp = TempDir::new().unwrap();
    let app = core(&temp);
    let offline = temp.path().join("offline");
    std::fs::create_dir(&offline).unwrap();
    let bytes = b"verified local fixture";
    let checksum = hex::encode(Sha256::digest(bytes));
    let mut manager = runtime::RuntimeManager::new(app.store.root.clone(), Arc::new(|_| {}));
    manager.catalog.artifacts = vec![RuntimeArtifact {
        id: "fixture-1".into(),
        component: "fixture".into(),
        version: "1.0.0".into(),
        platform: runtime::PLATFORM.into(),
        arch: runtime::ARCH.into(),
        url: "https://example.invalid/fixture".into(),
        sha256: checksum.clone(),
        archive: "file".into(),
        strip_components: 0,
        executables: BTreeMap::from([("fixture".into(), "bin/fixture".into())]),
        license: "MIT".into(),
        source_url: "https://example.invalid/source".into(),
        size: bytes.len() as u64,
    }];
    std::fs::write(offline.join(&checksum), b"corrupt").unwrap();
    assert!(manager
        .install("fixture-1", "bad", Some(offline.clone()))
        .await
        .is_err());
    assert!(!manager.list()[0].installed);
    let incomplete = app.store.root.join("runtimes/fixture-1");
    std::fs::create_dir_all(&incomplete).unwrap();
    std::fs::write(incomplete.join("partial"), "interrupted installation").unwrap();
    std::fs::write(offline.join(&checksum), bytes).unwrap();
    manager
        .install("fixture-1", "retry", Some(offline))
        .await
        .unwrap();
    assert!(manager.list()[0].installed);
    assert!(!incomplete.join("partial").exists());
    assert_eq!(
        std::fs::read(manager.resolve("fixture", "1.0.0", "fixture").unwrap()).unwrap(),
        bytes
    );
}
#[tokio::test]
async fn occupied_port_is_not_taken_from_another_process() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let occupied = listener.local_addr().unwrap().port();
    let selected = stackcabin_core::process::available_port(occupied)
        .await
        .unwrap();
    assert_ne!(selected, occupied);
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", occupied))
        .await
        .is_ok());
}

#[tokio::test]
async fn restore_preserves_a_destination_created_during_verification() {
    let temp = TempDir::new().unwrap();
    let original = core(&temp);
    let project = original
        .create(temp.path(), "source", Preset::Static, true)
        .unwrap();
    let backup = original.backup(&project.id, "test").await.unwrap();
    let destination = temp.path().join("concurrent-user-folder");
    let concurrent = destination.clone();
    let restoring = AppCore::new(
        temp.path().join("restoring-app"),
        Arc::new(move |event| {
            if event.subject == "restore" && event.message == "Project files verified" {
                std::fs::create_dir(&concurrent).unwrap();
                std::fs::write(concurrent.join("user-work.txt"), "keep this").unwrap();
            }
        }),
    )
    .unwrap();
    assert!(restoring
        .restore(std::path::Path::new(&backup.path), &destination, true)
        .await
        .is_err());
    assert_eq!(
        std::fs::read_to_string(destination.join("user-work.txt")).unwrap(),
        "keep this"
    );
}

// This ignored fixture is only launched as an owned child by the lifecycle test.
#[test]
#[ignore]
fn http_worker() {
    let port: u16 = std::env::var("STACKCABIN_TEST_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    for connection in listener.incoming() {
        let mut stream = connection.unwrap();
        let mut request = [0u8; 1024];
        let _ = stream.read(&mut request);
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    }
}
#[tokio::test]
async fn owned_native_process_health_and_shutdown_are_real() {
    let temp = TempDir::new().unwrap();
    let port = stackcabin_core::process::available_port(0).await.unwrap();
    let mut process = stackcabin_core::process::OwnedProcess::spawn(
        &std::env::current_exe().unwrap(),
        &[
            "--ignored".into(),
            "--exact".into(),
            "http_parent".into(),
            "--nocapture".into(),
        ],
        temp.path(),
        &BTreeMap::from([("STACKCABIN_TEST_PORT".into(), port.to_string())]),
        "worker",
        "test",
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    process.ready(port, true).await.unwrap();
    assert_eq!(process.info.state, ProcessState::Running);
    let body = reqwest::get(format!("http://127.0.0.1:{port}"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "OK");
    process.stop().await;
    assert_eq!(process.info.state, ProcessState::Stopped);
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err());
}

// This fixture deliberately outlives its launcher; the supervisor must own its grandchild.
#[test]
#[ignore]
#[allow(clippy::zombie_processes)]
fn http_parent() {
    let _worker = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "http_worker", "--nocapture"])
        .spawn()
        .unwrap();
    loop {
        if std::env::var_os("STACKCABIN_PARENT_EXIT_FILE")
            .is_some_and(|path| std::path::Path::new(&path).exists())
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[tokio::test]
async fn unexpected_parent_exit_reaps_owned_grandchildren() {
    let temp = TempDir::new().unwrap();
    let port = stackcabin_core::process::available_port(0).await.unwrap();
    let exit_file = temp.path().join("exit-parent");
    let mut process = stackcabin_core::process::OwnedProcess::spawn(
        &std::env::current_exe().unwrap(),
        &[
            "--ignored".into(),
            "--exact".into(),
            "http_parent".into(),
            "--nocapture".into(),
        ],
        temp.path(),
        &BTreeMap::from([
            ("STACKCABIN_TEST_PORT".into(), port.to_string()),
            (
                "STACKCABIN_PARENT_EXIT_FILE".into(),
                exit_file.to_string_lossy().into(),
            ),
        ]),
        "parent",
        "test",
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    process.ready(port, true).await.unwrap();
    std::fs::write(exit_file, "exit").unwrap();
    for _ in 0..100 {
        process.poll();
        if process.info.state == ProcessState::Failed
            && tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
        {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("Parent failure left an owned grandchild listening on {port}");
}
