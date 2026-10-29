use futures_util::poll;
use stackcabin_core::{
    models::*,
    process::{available_port, Supervisor},
    project,
    runtime::{self, RuntimeManager},
    store, AppCore,
};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tempfile::TempDir;

fn checkpoint(
    message: &'static str,
) -> (
    runtime::EventSink,
    Arc<tokio::sync::Notify>,
    mpsc::Sender<()>,
) {
    let (sender, receiver) = mpsc::channel();
    let receiver = Mutex::new(receiver);
    let entered = Arc::new(tokio::sync::Notify::new());
    let signal = entered.clone();
    let sink: runtime::EventSink = Arc::new(move |event| {
        if event.message == message {
            signal.notify_one();
            receiver
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(15))
                .expect("Test did not release checkpoint");
        }
    });
    (sink, entered, sender)
}

async fn reached(entered: &tokio::sync::Notify) {
    tokio::time::timeout(Duration::from_secs(10), entered.notified())
        .await
        .expect("Operation did not reach checkpoint");
}

fn file_artifact(id: &str, hash: &str) -> RuntimeArtifact {
    RuntimeArtifact {
        id: id.into(),
        component: "fixture".into(),
        version: "1.0.0".into(),
        platform: runtime::PLATFORM.into(),
        arch: runtime::ARCH.into(),
        url: "https://example.invalid/fixture".into(),
        sha256: hash.into(),
        archive: "file".into(),
        strip_components: 0,
        executables: BTreeMap::from([("fixture".into(), "bin/fixture".into())]),
        license: "MIT".into(),
        source_url: "https://example.invalid/source".into(),
        size: 7,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_cancels_active_and_queued_installs_without_publishing_receipts() {
    use sha2::{Digest, Sha256};
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("runtime shutdown ทดสอบ");
    let _store = store::Store::open(&root).unwrap();
    let offline = temp.path().join("offline");
    std::fs::create_dir(&offline).unwrap();
    let bytes = b"fixture";
    let hash = hex::encode(Sha256::digest(bytes));
    std::fs::write(offline.join(&hash), bytes).unwrap();
    let (sink, entered, release) = checkpoint("Verifying and extracting");
    let mut manager = RuntimeManager::new(root.clone(), sink);
    manager.catalog.artifacts = vec![
        file_artifact("first", &hash),
        file_artifact("queued", &hash),
    ];
    let manager = Arc::new(manager);
    let worker_manager = manager.clone();
    let first_offline = offline.clone();
    let first = tokio::spawn(async move {
        worker_manager
            .install("first", "first-op", Some(first_offline))
            .await
    });
    reached(&entered).await;
    let incomplete = root.join("runtimes/queued");
    std::fs::create_dir(&incomplete).unwrap();
    std::fs::write(incomplete.join("keep-partial"), "existing incomplete data").unwrap();
    let queued = manager.install("queued", "queued-op", Some(offline.clone()));
    tokio::pin!(queued);
    assert!(poll!(queued.as_mut()).is_pending());
    manager.begin_shutdown();
    let idle = manager.wait_idle();
    tokio::pin!(idle);
    assert!(poll!(idle.as_mut()).is_pending());
    assert!(queued.await.unwrap_err().to_string().contains("cancelled"));
    assert!(
        poll!(idle.as_mut()).is_pending(),
        "Active extraction has not cleaned up"
    );
    release.send(()).unwrap();
    assert!(first
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("cancelled"));
    tokio::time::timeout(Duration::from_secs(5), idle)
        .await
        .unwrap();
    assert!(manager.list().iter().all(|entry| !entry.installed));
    assert!(!root.join("runtimes/first").exists());
    assert!(
        incomplete.join("keep-partial").is_file(),
        "Cancelled queued install deleted existing files"
    );
    assert_eq!(std::fs::read_dir(root.join("staging")).unwrap().count(), 0);
    assert!(std::fs::read_dir(root.join("downloads"))
        .unwrap()
        .all(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_none_or(|ext| ext != "part")));
    assert!(manager
        .install("first", "late", Some(offline))
        .await
        .unwrap_err()
        .to_string()
        .contains("shutting down"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_waits_for_a_real_backup_and_rejects_new_project_work() {
    let temp = TempDir::new().unwrap();
    let (sink, entered, release) =
        checkpoint("Archiving project files; secrets and dependencies are excluded");
    let core = Arc::new(AppCore::new(temp.path().join("backup app ทดสอบ"), sink).unwrap());
    let project = core
        .create(temp.path(), "source", Preset::Static, true)
        .unwrap();
    let worker_core = core.clone();
    let worker_id = project.id.clone();
    let backup =
        tokio::spawn(async move { worker_core.backup(&worker_id, "accepted-backup").await });
    reached(&entered).await;
    core.begin_shutdown();
    let shutdown = core.shutdown();
    tokio::pin!(shutdown);
    assert!(poll!(shutdown.as_mut()).is_pending());
    assert!(core
        .create(temp.path(), "late-project", Preset::Static, false)
        .unwrap_err()
        .to_string()
        .contains("shutting down"));
    assert!(!temp.path().join("late-project").exists());
    assert!(core
        .start_project(&project.id)
        .await
        .unwrap_err()
        .to_string()
        .contains("shutting down"));
    assert!(core
        .prepare(&project.id, "late-prepare")
        .await
        .unwrap_err()
        .to_string()
        .contains("shutting down"));
    release.send(()).unwrap();
    let backup = backup.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(backup.path).unwrap()).unwrap();
    assert!(archive.by_name("backup.json").is_ok());
    assert!(archive.by_name("project/index.html").is_ok());
    assert!(core.activity().is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_restore_finishes_registration_after_shutdown_begins() {
    let temp = TempDir::new().unwrap();
    let source = AppCore::new(temp.path().join("source-app"), Arc::new(|_| {})).unwrap();
    let project = source
        .create(temp.path(), "source", Preset::Static, true)
        .unwrap();
    let project = source
        .attach_database(&project.id, DatabaseEngine::Sqlite)
        .await
        .unwrap();
    let database =
        rusqlite::Connection::open(Path::new(&project.path).join("storage/stackcabin.sqlite"))
            .unwrap();
    database.execute_batch("CREATE TABLE preserved(message TEXT); INSERT INTO preserved VALUES('accepted restore');").unwrap();
    drop(database);
    let archive = source.backup(&project.id, "source-backup").await.unwrap();
    source.shutdown().await;
    let (sink, entered, release) = checkpoint("Project files verified");
    let restoring = Arc::new(AppCore::new(temp.path().join("restoring-app"), sink).unwrap());
    let worker_core = restoring.clone();
    let destination = temp.path().join("restored ทดสอบ");
    let worker_destination = destination.clone();
    let restore = tokio::spawn(async move {
        worker_core
            .restore(Path::new(&archive.path), &worker_destination, true)
            .await
    });
    reached(&entered).await;
    restoring.begin_shutdown();
    let shutdown = restoring.shutdown();
    tokio::pin!(shutdown);
    assert!(poll!(shutdown.as_mut()).is_pending());
    release.send(()).unwrap();
    let restored = restore.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap();
    assert_eq!(
        restoring.store.project(&restored.id).unwrap().path,
        restored.path
    );
    let database =
        rusqlite::Connection::open(destination.join("storage/stackcabin.sqlite")).unwrap();
    let message: String = database
        .query_row("SELECT message FROM preserved", [], |row| row.get(0))
        .unwrap();
    assert_eq!(message, "accepted restore");
}

#[tokio::test]
async fn failed_laravel_preparation_cleans_generated_staging_and_keeps_source() {
    let temp = TempDir::new().unwrap();
    let core = AppCore::new(temp.path().join("app-data"), Arc::new(|_| {})).unwrap();
    let project = core
        .create(temp.path(), "laravel", Preset::Laravel, true)
        .unwrap();
    let root = Path::new(&project.path);
    std::fs::write(root.join("my-notes.txt"), "keep my source").unwrap();
    // No managed PHP is installed. Composer resolution fails after generation
    // staging is reserved; the temporary tree must still be removed.
    assert!(core.prepare(&project.id, "failed-prepare").await.is_err());
    assert!(root.join(".stackcabin-laravel-pending").is_file());
    assert_eq!(
        std::fs::read_to_string(root.join("my-notes.txt")).unwrap(),
        "keep my source"
    );
    assert_eq!(
        std::fs::read_dir(core.store.root.join("staging"))
            .unwrap()
            .count(),
        0
    );
    tokio::time::timeout(Duration::from_secs(5), core.shutdown())
        .await
        .unwrap();
}

#[tokio::test]
async fn supervisor_shutdown_cancels_and_reaps_a_real_dependency_task() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("task app ทดสอบ");
    let _store = store::Store::open(&root).unwrap();
    // A local test executable stands in for a resolved managed tool. No system
    // runtime, publisher catalog or global PATH is changed by this fixture.
    let mut manager = RuntimeManager::new(root.clone(), Arc::new(|_| {}));
    let mut artifact = file_artifact("test-node", &"a".repeat(64));
    artifact.component = "node".into();
    artifact.version = "24.0.0".into();
    let executable = if cfg!(windows) {
        "bin/worker.exe"
    } else {
        "bin/worker"
    };
    artifact.executables = BTreeMap::from([("node".into(), executable.into())]);
    let runtime_root = root.join("runtimes/test-node");
    std::fs::create_dir_all(runtime_root.join("bin")).unwrap();
    std::fs::copy(
        std::env::current_exe().unwrap(),
        runtime_root.join(executable),
    )
    .unwrap();
    std::fs::write(runtime_root.join(".stackcabin-receipt"), &artifact.sha256).unwrap();
    manager.catalog.artifacts = vec![artifact];
    let supervisor = Arc::new(Supervisor::new(
        root.clone(),
        Arc::new(manager),
        Arc::new(|_| {}),
    ));
    let project_root = temp.path().join("project");
    std::fs::create_dir(&project_root).unwrap();
    let port = available_port(0).await.unwrap();
    let mut spec = project::default_spec("task", Preset::Node);
    spec.runtimes[0].version = "24.0.0".into();
    spec.environment
        .insert("STACKCABIN_TASK_PORT".into(), port.to_string());
    let project = Project {
        id: "task-project".into(),
        path: project_root.to_string_lossy().into(),
        spec,
        trusted: true,
        created_at: "test".into(),
    };
    let worker = supervisor.clone();
    let running_project = project.clone();
    let task = tokio::spawn(async move {
        worker
            .run_task(
                &running_project,
                "node",
                &[
                    "--ignored".into(),
                    "--exact".into(),
                    "dependency_fixture".into(),
                    "--nocapture".into(),
                ],
                "active-dependencies",
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        while tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            assert!(
                !task.is_finished(),
                "Dependency fixture exited before becoming healthy"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let foreign = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(12), supervisor.shutdown())
        .await
        .unwrap();
    assert!(
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err(),
        "Shutdown returned before its task stopped"
    );
    assert!(task
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("cancelled"));
    assert!(
        tokio::net::TcpStream::connect(foreign.local_addr().unwrap())
            .await
            .is_ok()
    );
    assert!(supervisor
        .run_task(&project, "node", &[], "late-task")
        .await
        .unwrap_err()
        .to_string()
        .contains("shutting down"));
}

#[test]
#[ignore]
fn dependency_fixture() {
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
    let port: u16 = std::env::var("STACKCABIN_TASK_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(35);
    while std::time::Instant::now() < deadline {
        if let Ok((mut stream, _)) = listener.accept() {
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(50)))
                .unwrap();
            let _ = stream.read(&mut [0u8; 1024]);
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
