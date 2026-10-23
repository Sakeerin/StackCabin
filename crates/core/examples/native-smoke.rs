//! Real-runtime acceptance test. Keeps a disposable workspace for inspection.
//! STACKCABIN_SMOKE_DIR must point inside your intended test workspace.
use anyhow::{Context, Result};
use stackcabin_core::{
    models::*,
    runtime::{ARCH, PLATFORM},
    AppCore,
};
use std::{path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::var("STACKCABIN_SMOKE_DIR")
            .context("Set STACKCABIN_SMOKE_DIR to an explicit disposable test workspace")?,
    );
    std::fs::create_dir_all(&root)?;
    let root = root.canonicalize()?;
    let core = AppCore::new(
        root.join("app-data"),
        Arc::new(|event| {
            if ["error", "complete"].contains(&event.kind.as_str()) {
                println!("{}: {}", event.subject, event.message)
            }
        }),
    )?;
    anyhow::ensure!(
        core.runtimes.catalog_error.is_none(),
        "Catalog: {:?}",
        core.runtimes.catalog_error
    );
    let components = std::env::var("STACKCABIN_SMOKE_COMPONENTS")
        .unwrap_or_else(|_| "node,caddy,php,cacert,composer".into());
    let requirements: Vec<_> = core
        .runtimes
        .catalog
        .artifacts
        .iter()
        .filter(|a| {
            a.platform == PLATFORM
                && a.arch == ARCH
                && components.split(',').any(|c| c == a.component)
        })
        .cloned()
        .collect();
    for artifact in requirements {
        println!("Installing {}", artifact.id);
        if let Ok(cache) = std::env::var("STACKCABIN_PUBLISHER_CACHE") {
            use sha2::{Digest, Sha256};
            let key = hex::encode(Sha256::digest(artifact.url.as_bytes()));
            let source = PathBuf::from(cache).join(key);
            let destination = root.join("app-data/downloads").join(&artifact.sha256);
            if source.is_file() && !destination.exists() {
                std::fs::copy(source, destination)?;
            }
        }
        core.runtimes
            .install(
                &artifact.id,
                &artifact.id,
                std::env::var("STACKCABIN_OFFLINE_DIR")
                    .ok()
                    .map(PathBuf::from),
            )
            .await?;
        if ["php", "node"].contains(&artifact.component.as_str()) {
            let executable = core.runtimes.resolve(
                &artifact.component,
                &artifact.version,
                &artifact.component,
            )?;
            let output = tokio::process::Command::new(executable)
                .arg("--version")
                .output()
                .await?;
            anyhow::ensure!(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains(&artifact.version),
                "Managed executable version does not match its catalog selection"
            );
        }
    }
    let projects_dir = root.join("projects");
    std::fs::create_dir_all(&projects_dir)?;
    let mut ids = vec![];
    for (preset, branch) in [
        (Preset::Static, None),
        (Preset::Node, Some("22.")),
        (Preset::Node, Some("24.")),
        (Preset::Php, Some("8.4.")),
        (Preset::Php, Some("8.5.")),
    ] {
        if preset == Preset::Static && !components.contains("caddy") {
            continue;
        }
        if preset == Preset::Node && !components.contains("node") {
            continue;
        }
        if preset == Preset::Php && !components.contains("php") {
            continue;
        }
        let name = format!("smoke-{:?}-{}", preset, uuid::Uuid::new_v4().simple());
        let mut project = core.create(&projects_dir, &name, preset, true)?;
        if project.spec.preset == Preset::Node {
            for manager in ["npm", "pnpm", "yarn"] {
                if manager == "npm"
                    || core
                        .runtimes
                        .list()
                        .iter()
                        .any(|r| r.installed && r.artifact.component == manager)
                {
                    core.supervisor
                        .run_task(&project, manager, &["--version".into()], "manager-smoke")
                        .await?;
                    println!("PASS {manager} with selected Node.js");
                }
            }
        }
        if let Some(branch) = branch {
            let version = core
                .runtimes
                .list()
                .into_iter()
                .find(|r| {
                    r.installed
                        && r.artifact.component == project.spec.runtimes[0].component
                        && r.artifact.version.starts_with(branch)
                })
                .context("Required runtime branch is not installed")?
                .artifact
                .version;
            project.spec.runtimes[0].version = version;
            core.save_project(&project.id, project.spec.clone(), true)
                .await?;
        }
        let status = core.start_project(&project.id).await?;
        let info = status
            .processes
            .iter()
            .find(|p| p.port.is_some())
            .context("No listening process")?;
        let fallback = status.fallback_url.context("No loopback fallback")?;
        let fallback_body = reqwest::get(&fallback)
            .await?
            .error_for_status()?
            .text()
            .await?;
        anyhow::ensure!(
            fallback_body.contains("ready to build"),
            "Loopback route returned a different project"
        );
        let url = status.url.context("No routed URL")?;
        let proxy_port = url.rsplit(':').next().context("No proxy port")?;
        let response = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{proxy_port}/"))
            .header("Host", format!("{}.localhost", project.id))
            .send()
            .await?
            .error_for_status()?;
        let text = response.text().await?;
        anyhow::ensure!(
            text.contains("ready to build"),
            "Unexpected starter response: {text}"
        );
        println!("PASS {} {:?} {}", project.spec.name, info.state, url);
        ids.push(project.id);
    }
    // Database operations use real managed servers and OS credentials when explicitly requested.
    for engine in [DatabaseEngine::Mariadb, DatabaseEngine::Postgres] {
        let component = stackcabin_core::database::engine_id(&engine);
        if components.split(',').any(|c| c == component) {
            let project = core.create(
                &projects_dir,
                &format!("db-{component}-{}", uuid::Uuid::new_v4().simple()),
                Preset::Static,
                true,
            )?;
            let project = core.attach_database(&project.id, engine).await?;
            core.databases.query_project(&project,"CREATE TABLE cabin_smoke (message VARCHAR(120)); INSERT INTO cabin_smoke VALUES ('hello database');").await?;
            let result = core
                .databases
                .query_project(&project, "SELECT message FROM cabin_smoke;")
                .await?;
            anyhow::ensure!(
                result.contains("hello database"),
                "Database read/write failed"
            );
            let backup = core.backup(&project.id, "database-smoke").await?;
            let restored = core
                .restore(
                    std::path::Path::new(&backup.path),
                    &projects_dir.join(format!(
                        "restored-{component}-{}",
                        uuid::Uuid::new_v4().simple()
                    )),
                    true,
                )
                .await?;
            anyhow::ensure!(
                restored.spec.database.is_some(),
                "Database restore was not attached"
            );
            let result = core
                .databases
                .query_project(&restored, "SELECT message FROM cabin_smoke;")
                .await?;
            anyhow::ensure!(
                result.contains("hello database"),
                "Restored database lost data"
            );
            println!("PASS {component} provision / read / write / dump / restore");
        }
    }
    for id in ids {
        core.supervisor.stop(&id).await?;
        anyhow::ensure!(
            !core.supervisor.is_active(&id).await,
            "Project left running"
        );
    }
    core.shutdown().await;
    println!(
        "Native smoke passed on {PLATFORM}/{ARCH}. Workspace: {}",
        root.display()
    );
    Ok(())
}
