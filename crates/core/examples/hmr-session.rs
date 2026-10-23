//! Keep prepared, disposable framework fixtures running for real-browser HMR checks.
use anyhow::{Context, Result};
use stackcabin_core::{models::Preset, AppCore};
use std::{path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::var("STACKCABIN_SMOKE_DIR")
            .context("Set STACKCABIN_SMOKE_DIR to an existing disposable framework workspace")?,
    )
    .canonicalize()?;
    let core = AppCore::new(
        root.join("app-data"),
        Arc::new(|event| {
            if event.kind == "error" {
                eprintln!("{}: {}", event.subject, event.message);
            }
        }),
    )?;
    let result: Result<()> = async {
        let mut projects = core.store.projects()?;
        let project_root = root.join("projects").canonicalize()?;
        if std::env::var("STACKCABIN_HMR_FRESH_REACT").as_deref() == Ok("1") {
            let project = core.create(
                &project_root,
                &format!("hmr-react-{}", uuid::Uuid::new_v4().simple()),
                Preset::React,
                true,
            )?;
            core.prepare(&project.id, "hmr-fixture").await?;
            projects.insert(0, project);
        }
        let mut sessions = vec![];
        for preset in [Preset::React, Preset::Vue, Preset::Next] {
            let project = projects
                .iter()
                .find(|project| project.spec.preset == preset)
                .context("Run framework-smoke first to prepare the browser fixtures")?;
            anyhow::ensure!(
                project.trusted
                    && PathBuf::from(&project.path)
                        .canonicalize()?
                        .starts_with(&project_root),
                "Only trusted fixtures inside the disposable project directory may run"
            );
            anyhow::ensure!(
                PathBuf::from(&project.path).join("node_modules").is_dir(),
                "Install fixture dependencies first"
            );
            let status = core.start_project(&project.id).await?;
            sessions.push(
                serde_json::json!({"preset":preset,"path":project.path,"id":project.id,
                "url":status.url,"fallbackUrl":status.fallback_url}),
            );
        }
        let report = root.join("hmr-session.json");
        std::fs::write(&report, serde_json::to_vec_pretty(&sessions)?)?;
        println!("HMR session ready: {}", report.display());
        println!("Press Ctrl+C after verifying browser updates; all owned servers will stop.");
        tokio::signal::ctrl_c().await?;
        Ok(())
    }
    .await;
    core.shutdown().await;
    result
}
