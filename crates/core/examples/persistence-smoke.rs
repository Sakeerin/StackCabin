//! Verify a native-smoke fixture across packaged-application replacement.
//! No runtime installation or database re-provisioning occurs during verification.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use stackcabin_core::{models::*, AppCore, APPLICATION_ID};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

#[derive(Serialize, Deserialize)]
struct Baseline {
    schema: u32,
    application_id: String,
    projects: Vec<Project>,
    settings: Settings,
    installed: Vec<String>,
    files: BTreeMap<String, String>,
}

fn hash_file(file: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    if file
        .file_name()
        .is_some_and(|name| name == "stackcabin.json")
    {
        // A new DB port is allowed after restart; database/user/runtime identity
        // and every other manifest field must stay the same.
        let mut spec: serde_json::Value = serde_json::from_slice(&std::fs::read(file)?)?;
        if let Some(binding) = spec
            .get_mut("database")
            .and_then(|value| value.as_object_mut())
        {
            binding.insert("port".into(), 0.into());
        }
        hash.update(serde_json::to_vec(&spec)?);
    } else {
        std::io::copy(&mut std::fs::File::open(file)?, &mut hash)?;
    }
    Ok(hex::encode(hash.finalize()))
}

fn collect_files(core: &AppCore, workspace: &Path) -> Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    let mut directories = vec![core.store.root.join("backups")];
    for project in core.store.projects()? {
        let project_path = dunce::canonicalize(&project.path)?;
        anyhow::ensure!(
            project_path.starts_with(workspace.join("projects")),
            "Only native-smoke fixture projects inside the workspace are allowed"
        );
        directories.push(project_path);
    }
    for directory in directories {
        for entry in walkdir::WalkDir::new(directory) {
            let entry = entry?;
            anyhow::ensure!(
                !entry.file_type().is_symlink(),
                "Unexpected fixture symlink"
            );
            if entry.file_type().is_file() {
                files.insert(
                    entry
                        .path()
                        .strip_prefix(workspace)?
                        .to_string_lossy()
                        .into(),
                    hash_file(entry.path())?,
                );
            }
        }
    }
    for runtime in core.runtimes.list().into_iter().filter(|r| r.installed) {
        let directory = std::path::PathBuf::from(runtime.path.context("No installed path")?);
        for file in std::iter::once(directory.join(".stackcabin-receipt")).chain(
            runtime
                .artifact
                .executables
                .values()
                .map(|file| directory.join(file)),
        ) {
            files.insert(
                file.strip_prefix(workspace)?.to_string_lossy().into(),
                hash_file(&file)?,
            );
        }
    }
    Ok(files)
}

async fn baseline(core: &AppCore, workspace: &Path) -> Result<Baseline> {
    let state = core.snapshot().await?;
    let mut projects = state.projects;
    for project in &mut projects {
        if let Some(binding) = &mut project.spec.database {
            binding.port = 0;
        }
    }
    projects.sort_by(|a, b| a.id.cmp(&b.id));
    let mut installed: Vec<_> = state
        .runtimes
        .into_iter()
        .filter(|r| r.installed)
        .map(|r| r.artifact.id)
        .collect();
    installed.sort();
    Ok(Baseline {
        schema: 1,
        application_id: APPLICATION_ID.into(),
        projects,
        settings: state.settings,
        installed,
        files: collect_files(core, workspace)?,
    })
}

async fn assert_live_data(core: &AppCore, expected: &Baseline) -> Result<()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?;
    let mut databases = 0;
    let mut responses = Vec::new();
    for project in &expected.projects {
        if project.spec.database.is_some() {
            let result = core
                .databases
                .query_project(project, "SELECT message FROM cabin_smoke;")
                .await?;
            anyhow::ensure!(
                result.contains("hello database"),
                "Persisted database lost its row"
            );
            databases += 1;
        }
        let status = core.start_project(&project.id).await?;
        responses.push((
            project,
            status.fallback_url.context("No persisted project URL")?,
        ));
    }
    // Keep every project alive until all servers and credentials have been exercised.
    for (project, url) in responses {
        let response = client.get(url).send().await?.error_for_status()?;
        let version = match project.spec.preset {
            Preset::Node => Some(format!("v{}", project.spec.runtimes[0].version)),
            Preset::Php => Some(project.spec.runtimes[0].version.clone()),
            _ => None,
        };
        if let Some(version) = version {
            anyhow::ensure!(
                response
                    .headers()
                    .get("X-StackCabin-Runtime")
                    .and_then(|v| v.to_str().ok())
                    == Some(version.as_str()),
                "Persisted runtime pin changed"
            );
        }
        anyhow::ensure!(
            response.text().await?.contains("ready to build"),
            "Persisted project returned different content"
        );
    }
    anyhow::ensure!(
        databases == 5,
        "Expected original/restored MariaDB/PostgreSQL and SQLite"
    );
    println!("PASS all {} persisted projects: real HTTP/runtime versions and {databases} existing databases", expected.projects.len());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args().nth(1).context("Use record or verify")?;
    anyhow::ensure!(
        ["record", "verify"].contains(&mode.as_str()),
        "Use record or verify"
    );
    let workspace = dunce::canonicalize(
        std::env::var("STACKCABIN_SMOKE_DIR")
            .context("Set an explicit native-smoke fixture workspace")?,
    )?;
    let record = workspace.join("preservation-baseline.json");
    let core = AppCore::new(workspace.join("app-data"), Arc::new(|_| {}))?;
    anyhow::ensure!(
        core.runtimes.catalog_error.is_none(),
        "Invalid fixture catalog"
    );
    if mode == "record" {
        anyhow::ensure!(
            !record.exists(),
            "Never replace an existing preservation baseline"
        );
        let projects = core.store.projects()?;
        anyhow::ensure!(
            projects.len() == 9
                && projects.iter().all(|p| p.trusted
                    && ["smoke-", "db-", "restored-"]
                        .iter()
                        .any(|prefix| p.spec.name.starts_with(prefix))),
            "Prepare the complete native-smoke fixture in a fresh workspace first"
        );
        let project = core.create(
            &workspace.join("projects"),
            "persist-sqlite",
            Preset::Static,
            true,
        )?;
        let project = core
            .attach_database(&project.id, DatabaseEngine::Sqlite)
            .await?;
        core.databases.query_project(&project,
            "CREATE TABLE cabin_smoke (message VARCHAR(120)); INSERT INTO cabin_smoke VALUES ('hello database');").await?;
        core.store.save_settings(&Settings {
            language: "th".into(),
            theme: "dark".into(),
            close_to_tray: false,
            proxy_port: 18080,
        })?;
        core.shutdown().await;
        let state = baseline(&core, &workspace).await?;
        anyhow::ensure!(
            state.installed.len() == 11 && !state.files.is_empty(),
            "Incomplete installed fixture"
        );
        std::fs::write(record, serde_json::to_vec_pretty(&state)?)?;
        println!("PASS recorded ten real projects, runtime pins, settings, source/backup/executable hashes and five database identities");
    } else {
        let expected: Baseline = serde_json::from_slice(&std::fs::read(record)?)?;
        anyhow::ensure!(
            expected.schema == 1 && expected.application_id == APPLICATION_ID,
            "Wrong preservation fixture identity"
        );
        let actual = baseline(&core, &workspace).await?;
        anyhow::ensure!(
            serde_json::to_value(&expected)? == serde_json::to_value(&actual)?,
            "Persisted metadata, settings, runtime pins, sources, executables or backups changed"
        );
        let result = assert_live_data(&core, &expected).await;
        core.shutdown().await;
        result?;
        let actual = baseline(&core, &workspace).await?;
        anyhow::ensure!(
            serde_json::to_value(&expected)? == serde_json::to_value(&actual)?,
            "Live verification changed preserved application data"
        );
        println!("PASS unchanged project identities, trust, settings, selected runtimes, source files and backups across app restart/replacement");
    }
    Ok(())
}
