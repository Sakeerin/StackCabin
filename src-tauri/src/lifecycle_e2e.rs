//! Native lifecycle instrumentation, compiled only into explicitly selected E2E builds.
use crate::{AppCore, Lifecycle};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;

#[derive(Default)]
struct Evidence(Mutex<Vec<String>>);

pub(crate) fn setup(app: &tauri::AppHandle) {
    if std::env::var("STACKCABIN_LIFECYCLE_TEST").as_deref() == Ok("1") {
        app.manage(Evidence::default());
    }
}

pub(crate) fn record(app: &tauri::AppHandle, stage: &str) {
    if let Some(evidence) = app.try_state::<Evidence>() {
        let mut stages = evidence.0.lock().unwrap();
        stages.push(stage.into());
        let core = app.state::<Arc<AppCore>>();
        stackcabin_core::store::atomic_write(
            &core.store.root.join("lifecycle-evidence.json"),
            &serde_json::to_vec(&*stages).unwrap(),
        )
        .expect("Could not write lifecycle evidence");
    }
}

pub(crate) async fn before_shutdown(app: &tauri::AppHandle) {
    if app.try_state::<Evidence>().is_some() {
        record(app, "shutdown_started");
        // The external probe releases this barrier after checking repeated Quit
        // and the original window. Normal builds and ordinary E2E have no wait.
        let release = app
            .state::<Arc<AppCore>>()
            .store
            .root
            .join("lifecycle-release");
        tokio::time::timeout(Duration::from_secs(15), async {
            while !release.is_file() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Lifecycle test did not release shutdown");
        record(app, "shutdown_draining");
    }
}

#[tauri::command]
pub(crate) async fn lifecycle_test(
    app: tauri::AppHandle,
    action: String,
) -> Result<serde_json::Value, String> {
    if app.try_state::<Evidence>().is_none() {
        return Err("Lifecycle instrumentation is not enabled".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Main window missing")?;
    match action.as_str() {
        "inspect" => Ok(serde_json::json!({
            "pid": std::process::id(),
            "visible": window.is_visible().map_err(|e| e.to_string())?,
            "running": app.state::<Lifecycle>().running(),
        })),
        "close" => {
            window.close().map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "show" | "quit" => {
            super::tray_action(&app, &action);
            Ok(serde_json::Value::Null)
        }
        "start_worker" => {
            let core = app.state::<Arc<AppCore>>().inner().clone();
            let _activity = core.activity().map_err(|e| e.to_string())?;
            let port = stackcabin_core::process::available_port(0)
                .await
                .map_err(|e| e.to_string())?;
            core.supervisor
                .start_service(
                    "lifecycle-fixture",
                    &std::env::current_exe().map_err(|e| e.to_string())?,
                    &["--stackcabin-lifecycle-worker".into(), port.to_string()],
                    &BTreeMap::new(),
                    port,
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "port": port }))
        }
        "start_work" => {
            let core = app.state::<Arc<AppCore>>().inner().clone();
            let activity = core.activity().map_err(|e| e.to_string())?;
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                record(&handle, "work_started");
                let release = core.store.root.join("work-release");
                tokio::time::timeout(Duration::from_secs(15), async {
                    while !release.is_file() {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await
                .expect("Lifecycle test did not release accepted work");
                // Finish an already admitted metadata transaction after late
                // IPC writes have been rejected, just as normal IPC guards do.
                let mut settings = core.store.settings().unwrap();
                settings.theme = "dark".into();
                core.store.save_settings(&settings).unwrap();
                record(&handle, "work_finished");
                drop(activity);
            });
            Ok(serde_json::Value::Null)
        }
        _ => Err("Unknown lifecycle action".into()),
    }
}

/// A bounded, loopback-only child fixture with no dependency on system runtimes.
pub fn run_fixture() -> bool {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--stackcabin-lifecycle-worker") {
        return false;
    }
    assert_eq!(args.len(), 3);
    let port: u16 = args[2].parse().expect("Fixture port");
    assert!(port >= 1024);
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while std::time::Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") && request.len() < 16384 {
                    let mut chunk = [0u8; 1024];
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(size) => request.extend_from_slice(&chunk[..size]),
                    }
                }
                if !request.ends_with(b"\r\n\r\n") {
                    continue;
                }
                let body = "StackCabin lifecycle fixture";
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(e) => panic!("Fixture accept failed: {e}"),
        }
    }
    true
}
