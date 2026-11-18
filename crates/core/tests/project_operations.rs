use stackcabin_core::{models::*, AppCore};
use std::{
    path::Path,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tempfile::TempDir;

struct ReleaseOnDrop(Option<mpsc::Sender<()>>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

fn busy<T: std::fmt::Debug>(result: anyhow::Result<T>) {
    assert!(format!("{:#}", result.unwrap_err())
        .contains("Another operation is already active for this project"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_backup_excludes_same_project_mutations_without_blocking_other_projects() {
    let temp = TempDir::new().unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let signal = entered.clone();
    let (sender, receiver) = mpsc::channel();
    let receiver = Mutex::new(receiver);
    let core = Arc::new(
        AppCore::new(
            temp.path().join("app"),
            Arc::new(move |event| {
                if event.operation_id == "held-backup"
                    && event.message
                        == "Archiving project files; secrets and dependencies are excluded"
                {
                    signal.notify_one();
                    receiver
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(20))
                        .expect("Backup checkpoint was not released");
                }
            }),
        )
        .unwrap(),
    );
    let first = core
        .create(temp.path(), "first ทดสอบ", Preset::Static, true)
        .unwrap();
    let second = core
        .create(temp.path(), "second ทดสอบ", Preset::Static, true)
        .unwrap();
    let path = Path::new(&first.path);
    let config_before = std::fs::read(path.join("stackcabin.json")).unwrap();
    let lock_before = std::fs::read(path.join("stackcabin.lock.json")).unwrap();
    let worker = core.clone();
    let id = first.id.clone();
    let backup = tokio::spawn(async move { worker.backup(&id, "held-backup").await });
    let release = ReleaseOnDrop(Some(sender));
    tokio::time::timeout(Duration::from_secs(10), entered.notified())
        .await
        .expect("Backup did not reach checkpoint");

    let mut changed = first.spec.clone();
    changed.name = "must not overwrite active snapshot".into();
    busy(core.save_project(&first.id, changed, false).await);
    busy(core.start_project(&first.id).await);
    busy(core.stop_project(&first.id).await);
    busy(core.prepare(&first.id, "conflicting-prepare").await);
    busy(
        core.attach_database(&first.id, DatabaseEngine::Sqlite)
            .await,
    );
    busy(core.query_database(&first.id, "SELECT 1").await);
    busy(core.backup(&first.id, "conflicting-backup").await);
    busy(core.forget(&first.id).await);
    assert_eq!(
        std::fs::read(path.join("stackcabin.json")).unwrap(),
        config_before
    );
    assert_eq!(
        std::fs::read(path.join("stackcabin.lock.json")).unwrap(),
        lock_before
    );
    assert!(core.store.project(&first.id).unwrap().trusted);
    assert!(!path.join("storage").exists());

    // A different project's metadata, SQLite work and backup remain available.
    let mut other = second.spec.clone();
    other.name = "other project stays available".into();
    core.save_project(&second.id, other, true).await.unwrap();
    core.attach_database(&second.id, DatabaseEngine::Sqlite)
        .await
        .unwrap();
    core.query_database(
        &second.id,
        "CREATE TABLE notes(message TEXT); INSERT INTO notes VALUES('independent');",
    )
    .await
    .unwrap();
    assert!(core
        .query_database(&second.id, "SELECT message FROM notes")
        .await
        .unwrap()
        .contains("independent"));
    core.backup(&second.id, "other-backup").await.unwrap();

    drop(release);
    let saved = tokio::time::timeout(Duration::from_secs(10), backup)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(saved.path).unwrap()).unwrap();
    assert!(archive.by_name("project/index.html").is_ok());
    let mut after = first.spec;
    after.name = "changes allowed after cleanup".into();
    core.save_project(&first.id, after, true).await.unwrap();
    core.stop_project(&first.id).await.unwrap();
    core.forget(&first.id).await.unwrap();
    assert!(path.join("index.html").exists());
}

#[tokio::test]
async fn untrusted_start_rejects_before_database_port_or_project_files_change() {
    let temp = TempDir::new().unwrap();
    let core = AppCore::new(temp.path().join("app"), Arc::new(|_| {})).unwrap();
    let project = core
        .create(temp.path(), "untrusted SQLite", Preset::Static, true)
        .unwrap();
    let mut spec = project.spec;
    // SQLite startup would normalize this to zero before the old late trust check.
    spec.database = Some(DatabaseBinding {
        engine: DatabaseEngine::Sqlite,
        name: "storage/never-opened.sqlite".into(),
        username: String::new(),
        port: 43210,
    });
    let project = core.save_project(&project.id, spec, false).await.unwrap();
    let path = Path::new(&project.path);
    let before = std::fs::read(path.join("stackcabin.json")).unwrap();
    let error = core.start_project(&project.id).await.unwrap_err();
    assert!(format!("{error:#}").contains("Trust this project before executing its code"));
    assert_eq!(std::fs::read(path.join("stackcabin.json")).unwrap(), before);
    assert_eq!(
        core.store
            .project(&project.id)
            .unwrap()
            .spec
            .database
            .unwrap()
            .port,
        43210
    );
    assert!(!path.join("storage").exists());
    assert!(!core.supervisor.is_active(&project.id).await);
}

#[tokio::test]
async fn failed_actions_release_the_project_and_operation_identifier_for_retry() {
    let temp = TempDir::new().unwrap();
    let core = AppCore::new(temp.path().join("app"), Arc::new(|_| {})).unwrap();
    let project = core
        .create(temp.path(), "missing runtime", Preset::Node, true)
        .unwrap();
    assert!(core.prepare(&project.id, "retry-prepare").await.is_err());
    // Reuse the exact ID: failure must release both admission keys.
    let error = core
        .prepare(&project.id, "retry-prepare")
        .await
        .unwrap_err();
    assert!(!format!("{error:#}").contains("already active"));
    assert!(core.start_project(&project.id).await.is_err());
    let mut spec = project.spec;
    spec.name = "settings still work after errors".into();
    core.save_project(&project.id, spec, false).await.unwrap();
    core.stop_project(&project.id).await.unwrap();
    core.forget(&project.id).await.unwrap();
    assert!(Path::new(&project.path).join("package.json").is_file());
}
