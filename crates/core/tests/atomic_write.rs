use stackcabin_core::store::atomic_write;
use std::{fs, path::Path};
use tempfile::TempDir;

fn entries(directory: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn creates_and_replaces_files_under_missing_unicode_directories() {
    let temp = TempDir::new().unwrap();
    let directory = temp.path().join("การตั้งค่า ใหม่/nested folder");
    let path = directory.join("stackcabin.json");
    atomic_write(&path, b"first").unwrap();
    atomic_write(&path, b"second").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"second");
    assert_eq!(entries(&directory), ["stackcabin.json"]);
}

#[test]
fn failed_publication_preserves_destination_and_unrelated_files() {
    let temp = TempDir::new().unwrap();
    let directory = temp.path().join("settings.json");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("keep.txt"), b"original").unwrap();
    fs::write(temp.path().join("unrelated.tmp"), b"another operation").unwrap();

    assert!(atomic_write(&directory, b"replacement").is_err());
    assert_eq!(fs::read(directory.join("keep.txt")).unwrap(), b"original");
    assert_eq!(entries(temp.path()), ["settings.json", "unrelated.tmp"]);
    assert_eq!(
        fs::read(temp.path().join("unrelated.tmp")).unwrap(),
        b"another operation"
    );
}

#[test]
fn concurrent_readers_only_observe_complete_documents() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Barrier,
    };

    let temp = TempDir::new().unwrap();
    let path = temp.path().join("settings.json");
    let first = serde_json::to_vec(&"a".repeat(32 * 1024)).unwrap();
    let second = serde_json::to_vec(&"b".repeat(64 * 1024)).unwrap();
    atomic_write(&path, &first).unwrap();
    let done = AtomicBool::new(false);
    let ready = Barrier::new(2);

    std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            let initial = fs::read(&path).unwrap();
            assert_eq!(initial, first);
            ready.wait();
            let mut reads = 1;
            while !done.load(Ordering::Acquire) {
                let bytes = fs::read(&path).unwrap();
                assert!(bytes == first || bytes == second, "Partial document read");
                reads += 1;
                std::thread::yield_now();
            }
            reads
        });
        ready.wait();
        let result = (0..40).try_for_each(|index| {
            atomic_write(&path, if index % 2 == 0 { &second } else { &first })
        });
        done.store(true, Ordering::Release);
        assert!(reader.join().unwrap() > 1);
        result.unwrap();
    });
    assert_eq!(entries(temp.path()), ["settings.json"]);
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        os::windows::fs::OpenOptionsExt,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn reader_preventing_replacement(path: &Path) -> fs::File {
        // A real Windows reader permits reads but does not share delete/rename.
        fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(path)
            .unwrap()
    }

    #[test]
    fn replacement_waits_for_a_reader_to_release_its_handle() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("การตั้งค่า ทดสอบ.json");
        atomic_write(&path, b"original").unwrap();
        let locked = reader_preventing_replacement(&path);
        std::thread::scope(|scope| {
            let (started, ready) = mpsc::channel();
            let (result, finished) = mpsc::channel();
            let destination = &path;
            scope.spawn(move || {
                started.send(()).unwrap();
                result
                    .send(atomic_write(destination, b"replacement"))
                    .unwrap();
            });
            ready.recv_timeout(Duration::from_secs(5)).unwrap();
            let early = finished.recv_timeout(Duration::from_millis(100));
            let original = fs::read(&path).unwrap();
            // Always release the handle before asserting so failure cannot strand a worker.
            drop(locked);
            assert!(matches!(early, Err(mpsc::RecvTimeoutError::Timeout)));
            assert_eq!(original, b"original");
            finished
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
        });
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(entries(temp.path()), ["การตั้งค่า ทดสอบ.json"]);
    }

    #[test]
    fn persistent_lock_returns_an_error_without_losing_data_and_allows_retry() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        atomic_write(&path, b"original").unwrap();
        let locked = reader_preventing_replacement(&path);
        let start = Instant::now();
        let error = atomic_write(&path, b"replacement").unwrap_err();
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(error.downcast_ref::<std::io::Error>().is_some());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(entries(temp.path()), ["settings.json"]);
        drop(locked);
        atomic_write(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
    }

    #[test]
    fn read_only_destination_remains_unchanged_and_cleans_staging() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("settings.json");
        atomic_write(&path, b"original").unwrap();
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut read_only = original_permissions.clone();
        read_only.set_readonly(true);
        fs::set_permissions(&path, read_only).unwrap();
        let result = atomic_write(&path, b"replacement");
        let still_read_only = fs::metadata(&path).unwrap().permissions().readonly();
        fs::set_permissions(&path, original_permissions).unwrap();
        assert!(result.is_err());
        assert!(still_read_only);
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(entries(temp.path()), ["settings.json"]);
    }
}
