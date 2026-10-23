//! Exercise generated starters with real package installers and real HTTP servers.
use anyhow::{Context, Result};
use stackcabin_core::{models::Preset, AppCore};
use std::{path::PathBuf, sync::Arc};
#[tokio::main]
async fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::var("STACKCABIN_SMOKE_DIR")
            .context("Set STACKCABIN_SMOKE_DIR to an explicit test workspace")?,
    );
    std::fs::create_dir_all(root.join("projects"))?;
    let core = AppCore::new(
        root.join("app-data"),
        Arc::new(|event| {
            if event.kind != "progress" {
                println!("{} {}", event.subject, event.message)
            }
        }),
    )?;
    let requested = std::env::var("STACKCABIN_FRAMEWORKS")
        .unwrap_or_else(|_| "express,vue,react,nest,next,laravel".into());
    for (id, preset, resource) in [
        ("express", Preset::Express, "/"),
        ("vue", Preset::Vue, "/src/App.vue"),
        ("react", Preset::React, "/src/main.jsx"),
        ("nest", Preset::Nest, "/"),
        ("next", Preset::Next, "/"),
        ("laravel", Preset::Laravel, "/"),
    ] {
        if !requested.split(',').any(|value| value == id) {
            continue;
        }
        let project = core.create(
            &root.join("projects"),
            &format!("framework-{id}-{}", uuid::Uuid::new_v4().simple()),
            preset,
            true,
        )?;
        let result: Result<()> = async {
            core.prepare(&project.id, "framework-smoke").await?;
            let status = core.start_project(&project.id).await?;
            let port = status
                .url
                .context("No project URL")?
                .rsplit(':')
                .next()
                .context("No proxy port")?
                .to_string();
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(90))
                .build()?;
            let response = client
                .get(format!("http://127.0.0.1:{port}{resource}"))
                .header("Host", format!("{}.localhost", project.id))
                .send()
                .await?
                .error_for_status()?;
            let body = response.text().await?;
            anyhow::ensure!(!body.is_empty(), "Empty {id} response");
            if ["vue", "react"].contains(&id) {
                let hmr = client
                    .get(format!("http://127.0.0.1:{port}/@vite/client"))
                    .header("Host", format!("{}.localhost", project.id))
                    .send()
                    .await?
                    .error_for_status()?
                    .text()
                    .await?;
                anyhow::ensure!(
                    hmr.contains("WebSocket") || hmr.contains("createHotContext"),
                    "Vite HMR client unavailable"
                );
            }
            println!(
                "PASS {id} install / compile / HTTP{}",
                if ["vue", "react"].contains(&id) {
                    " / HMR client"
                } else {
                    ""
                }
            );
            Ok(())
        }
        .await;
        let _ = core.supervisor.stop(&project.id).await;
        if let Err(error) = result {
            core.shutdown().await;
            return Err(error).context(format!("{id} acceptance failed"));
        }
    }
    core.shutdown().await;
    Ok(())
}
