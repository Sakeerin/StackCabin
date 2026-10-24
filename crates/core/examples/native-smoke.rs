//! Real-runtime acceptance test. Keeps a disposable workspace for inspection.
//! STACKCABIN_SMOKE_DIR must point inside your intended test workspace.
use anyhow::{Context, Result};
use stackcabin_core::{
    models::*,
    runtime::{ARCH, PLATFORM},
    AppCore,
};
use std::{path::PathBuf, sync::Arc, time::Duration};

#[path = "support/persistence.rs"]
mod persistence;

// Re-check every project after the other runtimes and databases have started.
// A successful first request alone cannot detect shared FPM configuration or
// environment changes that accidentally redirect a previously running project.
async fn assert_project_response(url: &str, host: &str, runtime: Option<&str>) -> Result<()> {
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()?
        .get(url)
        .header("Host", host)
        .timeout(Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?;
    if let Some(runtime) = runtime {
        anyhow::ensure!(
            response
                .headers()
                .get("X-StackCabin-Runtime")
                .and_then(|v| v.to_str().ok())
                == Some(runtime),
            "Server at {url} used a different runtime than {runtime}"
        );
    }
    anyhow::ensure!(
        response.text().await?.contains("ready to build"),
        "Server at {url} returned a different project"
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        None => {}
        Some("record-persistence") => return persistence::run("record").await,
        Some("verify-persistence") => return persistence::run("verify").await,
        Some(_) => anyhow::bail!("Use no argument, record-persistence or verify-persistence"),
    }
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
        if ["php", "node", "mariadb", "postgres"].contains(&artifact.component.as_str()) {
            let tool = match artifact.component.as_str() {
                "mariadb" => "mariadbd",
                other => other,
            };
            let executable = core
                .runtimes
                .resolve(&artifact.component, &artifact.version, tool)?;
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
    let mut observations = vec![];
    let branches = std::env::var("STACKCABIN_SMOKE_BRANCHES").ok();
    for (preset, branch) in [
        (Preset::Static, None),
        (Preset::Node, Some("22.")),
        (Preset::Node, Some("24.")),
        (Preset::Php, Some("8.4.")),
        (Preset::Php, Some("8.5.")),
    ] {
        if branch.is_some_and(|branch| {
            branches
                .as_ref()
                .is_some_and(|selected| !selected.split(',').any(|item| item == branch))
        }) {
            continue;
        }
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
        if project.spec.preset == Preset::Node {
            // Observe the actual server executable, independently of the manifest selection.
            let server = PathBuf::from(&project.path).join("server.mjs");
            let source = std::fs::read_to_string(&server)?;
            std::fs::write(
                server,
                source.replace(
                    "res.setHeader('Content-Type'",
                    "res.setHeader('X-StackCabin-Runtime',process.version);res.setHeader('Content-Type'",
                ),
            )?;
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
                    println!(
                        "PASS {manager} with Node.js {}",
                        project.spec.runtimes[0].version
                    );
                }
            }
        }
        if project.spec.preset == Preset::Php {
            let index = PathBuf::from(&project.path).join("index.php");
            let source = std::fs::read_to_string(&index)?;
            std::fs::write(
                index,
                format!("<?php header('X-StackCabin-Runtime: '.PHP_VERSION); ?>{source}"),
            )?;
        }
        let status = core.start_project(&project.id).await?;
        let info = status
            .processes
            .iter()
            .find(|p| p.port.is_some())
            .context("No listening process")?;
        let fallback = status.fallback_url.context("No loopback fallback")?;
        let url = status.url.context("No routed URL")?;
        let proxy_port = url.rsplit(':').next().context("No proxy port")?;
        let runtime = match project.spec.preset {
            Preset::Node => Some(format!("v{}", project.spec.runtimes[0].version)),
            Preset::Php => Some(project.spec.runtimes[0].version.clone()),
            _ => None,
        };
        let routed = format!("http://127.0.0.1:{proxy_port}/");
        let host = format!("{}.localhost", project.id);
        assert_project_response(&routed, &host, runtime.as_deref()).await?;
        assert_project_response(&fallback, "127.0.0.1", runtime.as_deref()).await?;
        observations.push((routed, host, fallback, runtime));
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
    for (routed, host, fallback, runtime) in observations {
        assert_project_response(&routed, &host, runtime.as_deref()).await?;
        assert_project_response(&fallback, "127.0.0.1", runtime.as_deref()).await?;
    }
    println!(
        "PASS all {} projects remain reachable with their selected runtime",
        ids.len()
    );
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
