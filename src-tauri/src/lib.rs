use stackcabin_core::{models::*, AppCore};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};
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
    let project = core.store.project(&id).map_err(message)?;
    core.databases
        .query_project(&project, &sql)
        .await
        .map_err(message)
}
#[tauri::command]
async fn service_start(core: Core<'_>, engine: DatabaseEngine) -> Result<u16, String> {
    core.databases.start(&engine).await.map_err(message)
}
#[tauri::command]
async fn service_stop(core: Core<'_>, id: String) -> Result<(), String> {
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
    core.backups
        .export(&id, std::path::Path::new(&destination))
        .map_err(message)
}
#[tauri::command]
fn settings_save(core: Core<'_>, settings: Settings) -> Result<(), String> {
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
    stackcabin_core::open_external(&core.store.root.to_string_lossy()).map_err(message)
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());
    builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
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
            app.manage(Arc::new(AtomicBool::new(false)));
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
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let core = window.state::<Arc<AppCore>>();
                if core
                    .store
                    .settings()
                    .map(|s| s.close_to_tray)
                    .unwrap_or(true)
                {
                    api.prevent_close();
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
            data_open
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize StackCabin")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let quitting = app.state::<Arc<AtomicBool>>();
                if !quitting.swap(true, Ordering::SeqCst) {
                    api.prevent_exit();
                    let handle = app.clone();
                    let core = app.state::<Arc<AppCore>>().inner().clone();
                    tauri::async_runtime::spawn(async move {
                        core.shutdown().await;
                        handle.exit(0);
                    });
                }
            }
        });
}
