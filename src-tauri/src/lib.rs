use stackcabin_core::{models::*, AppCore};
use std::{path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager};
mod lifecycle;
#[cfg(feature = "e2e")]
pub mod lifecycle_e2e;
use lifecycle::{ExitDecision, Lifecycle};
type Core<'a> = tauri::State<'a, Arc<AppCore>>;
fn message(error: anyhow::Error) -> String {
    format!("{error:#}")
}

#[tauri::command]
async fn snapshot(core: Core<'_>) -> Result<Snapshot, String> {
    core.snapshot().await.map_err(message)
}
#[tauri::command]
fn project_detect(path: String) -> Result<ProjectSpec, String> {
    stackcabin_core::project::detect(std::path::Path::new(&path)).map_err(message)
}
#[tauri::command]
fn project_import(
    core: Core<'_>,
    path: String,
    spec: ProjectSpec,
    trusted: bool,
) -> Result<Project, String> {
    core.import(std::path::Path::new(&path), spec, trusted)
        .map_err(message)
}
#[tauri::command]
fn project_create(
    core: Core<'_>,
    parent: String,
    name: String,
    preset: Preset,
    trusted: bool,
) -> Result<Project, String> {
    core.create(std::path::Path::new(&parent), &name, preset, trusted)
        .map_err(message)
}
#[tauri::command]
async fn project_save(
    core: Core<'_>,
    id: String,
    spec: ProjectSpec,
    trusted: bool,
) -> Result<Project, String> {
    core.save_project(&id, spec, trusted).await.map_err(message)
}
#[tauri::command]
async fn project_start(core: Core<'_>, id: String) -> Result<ProjectStatus, String> {
    core.start_project(&id).await.map_err(message)
}
#[tauri::command]
async fn project_stop(core: Core<'_>, id: String) -> Result<(), String> {
    let _activity = core.activity().map_err(message)?;
    core.supervisor.stop(&id).await.map_err(message)
}
#[tauri::command]
async fn project_forget(core: Core<'_>, id: String) -> Result<(), String> {
    core.forget(&id).await.map_err(message)
}
#[tauri::command]
async fn project_prepare(core: Core<'_>, id: String, operation_id: String) -> Result<(), String> {
    core.prepare(&id, &operation_id).await.map_err(message)
}
#[tauri::command]
async fn project_open(core: Core<'_>, id: String, target: String) -> Result<(), String> {
    core.open_project(&id, &target).await.map_err(message)
}
#[tauri::command]
async fn runtime_install(
    core: Core<'_>,
    id: String,
    operation_id: String,
    offline_folder: Option<String>,
) -> Result<(), String> {
    core.runtimes
        .install(&id, &operation_id, offline_folder.map(PathBuf::from))
        .await
        .map_err(message)
}
#[tauri::command]
async fn runtime_remove(core: Core<'_>, id: String) -> Result<(), String> {
    let _activity = core.activity().map_err(message)?;
    if core.supervisor.service_state("caddy").await == ProcessState::Running
        || !core.supervisor.statuses().await.iter().all(|s| {
            s.processes
                .iter()
                .all(|p| matches!(p.state, ProcessState::Stopped | ProcessState::Failed))
        })
    {
        return Err("Stop all projects and services before removing runtimes".into());
    }
    for service in ["mariadb", "postgres"] {
        if core.supervisor.service_state(service).await == ProcessState::Running {
            return Err("Stop database services before removing runtimes".into());
        }
    }
    core.runtimes
        .remove(&id, &core.store.projects().map_err(message)?)
        .map_err(message)
}
#[tauri::command]
async fn operation_cancel(core: Core<'_>, id: String) -> Result<(), String> {
    core.cancel(&id).await;
    Ok(())
}
#[tauri::command]
async fn database_attach(
    core: Core<'_>,
    id: String,
    engine: DatabaseEngine,
) -> Result<Project, String> {
    core.attach_database(&id, engine).await.map_err(message)
}
#[tauri::command]
async fn database_query(core: Core<'_>, id: String, sql: String) -> Result<String, String> {
    let _activity = core.activity().map_err(message)?;
    let project = core.store.project(&id).map_err(message)?;
    core.databases
        .query_project(&project, &sql)
        .await
        .map_err(message)
}
#[tauri::command]
async fn service_start(core: Core<'_>, engine: DatabaseEngine) -> Result<u16, String> {
    let _activity = core.activity().map_err(message)?;
    core.databases.start(&engine).await.map_err(message)
}
#[tauri::command]
async fn service_stop(core: Core<'_>, id: String) -> Result<(), String> {
    let _activity = core.activity().map_err(message)?;
    if core.store.projects().map_err(message)?.iter().any(|p| {
        p.spec
            .database
            .as_ref()
            .is_some_and(|b| stackcabin_core::database::engine_id(&b.engine) == id)
    }) {
        for project in core.store.projects().map_err(message)? {
            if project
                .spec
                .database
                .as_ref()
                .is_some_and(|b| stackcabin_core::database::engine_id(&b.engine) == id)
                && core.supervisor.is_active(&project.id).await
            {
                return Err("Stop projects using this database before stopping the service".into());
            }
        }
    }
    core.databases.stop(&id).await.map_err(message)
}
#[tauri::command]
async fn backup_create(
    core: Core<'_>,
    id: String,
    operation_id: String,
) -> Result<BackupInfo, String> {
    core.backup(&id, &operation_id).await.map_err(message)
}
#[tauri::command]
async fn backup_restore(
    core: Core<'_>,
    archive: String,
    destination: String,
    trusted: bool,
) -> Result<Project, String> {
    core.restore(
        std::path::Path::new(&archive),
        std::path::Path::new(&destination),
        trusted,
    )
    .await
    .map_err(message)
}
#[tauri::command]
fn backup_export(core: Core<'_>, id: String, destination: String) -> Result<(), String> {
    let _activity = core.activity().map_err(message)?;
    core.backups
        .export(&id, std::path::Path::new(&destination))
        .map_err(message)
}
#[tauri::command]
fn settings_save(core: Core<'_>, settings: Settings) -> Result<(), String> {
    let _activity = core.activity().map_err(message)?;
    core.store.save_settings(&settings).map_err(message)
}
#[tauri::command]
fn doctor(core: Core<'_>) -> Vec<Diagnostic> {
    core.doctor()
}
#[tauri::command]
fn logs(core: Core<'_>, subject: Option<String>) -> Vec<AppEvent> {
    core.logs(subject.as_deref())
}
#[tauri::command]
fn data_open(core: Core<'_>) -> Result<(), String> {
    let _activity = core.activity().map_err(message)?;
    stackcabin_core::open_external(&core.store.root.to_string_lossy()).map_err(message)
}

fn show_main(app: &tauri::AppHandle) {
    if app
        .try_state::<Lifecycle>()
        .is_some_and(|state| state.running())
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

fn tray_action(app: &tauri::AppHandle, action: &str) {
    match action {
        "show" => show_main(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());
    builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if app.config().identifier != stackcabin_core::APPLICATION_ID {
                return Err(anyhow::anyhow!(
                    "Application identity must match the compiled credential namespace"
                )
                .into());
            }
            let handle = app.handle().clone();
            let root = std::env::var_os("STACKCABIN_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(app.path().app_data_dir()?);
            let core = Arc::new(AppCore::new(
                root,
                Arc::new(move |event| {
                    let _ = handle.emit("stackcabin:event", event);
                }),
            )?);
            app.manage(core);
            app.manage(Lifecycle::default());
            #[cfg(feature = "e2e")]
            lifecycle_e2e::setup(app.handle());
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{TrayIconBuilder, TrayIconEvent},
            };
            let show = MenuItem::with_id(app, "show", "Open StackCabin", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit StackCabin", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("StackCabin · Your local workspace")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| tray_action(app, event.id.as_ref()))
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Keep the WebView alive while asynchronous shutdown is running.
                // Only the completed shutdown may destroy the final window.
                api.prevent_close();
                let core = window.state::<Arc<AppCore>>();
                if core
                    .store
                    .settings()
                    .map(|s| s.close_to_tray)
                    .unwrap_or(true)
                {
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            project_detect,
            project_import,
            project_create,
            project_save,
            project_start,
            project_stop,
            project_forget,
            project_prepare,
            project_open,
            runtime_install,
            runtime_remove,
            operation_cancel,
            database_attach,
            database_query,
            service_start,
            service_stop,
            backup_create,
            backup_restore,
            backup_export,
            settings_save,
            doctor,
            logs,
            data_open,
            #[cfg(feature = "e2e")]
            lifecycle_e2e::lifecycle_test
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize StackCabin")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                match app.state::<Lifecycle>().request_exit() {
                    ExitDecision::Exit => {
                        #[cfg(feature = "e2e")]
                        lifecycle_e2e::record(app, "exit_allowed");
                    }
                    ExitDecision::Wait => {
                        api.prevent_exit();
                        #[cfg(feature = "e2e")]
                        lifecycle_e2e::record(app, "exit_waiting");
                    }
                    ExitDecision::BeginShutdown => {
                        api.prevent_exit();
                        app.state::<Arc<AppCore>>().begin_shutdown();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_enabled(false);
                        }
                        let handle = app.clone();
                        let core = app.state::<Arc<AppCore>>().inner().clone();
                        tauri::async_runtime::spawn(async move {
                            #[cfg(feature = "e2e")]
                            lifecycle_e2e::before_shutdown(&handle).await;
                            core.shutdown().await;
                            #[cfg(feature = "e2e")]
                            lifecycle_e2e::record(&handle, "shutdown_complete");
                            handle.state::<Lifecycle>().complete();
                            handle.exit(0);
                        });
                    }
                }
            }
        });
}
