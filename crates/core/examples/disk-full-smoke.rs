//! Linux CI acceptance against an explicitly supplied, bounded tmpfs volume.
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("This acceptance test requires a dedicated Linux tmpfs volume.");
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use anyhow::{Context, Result};
    use sha2::{Digest, Sha256};
    use stackcabin_core::{models::RuntimeArtifact, runtime};
    use std::{collections::BTreeMap, io::Write, path::PathBuf, sync::Arc};

    let volume = PathBuf::from(
        std::env::var("STACKCABIN_QUOTA_ROOT")
            .context("Set STACKCABIN_QUOTA_ROOT to a dedicated 32 MiB CI tmpfs mount")?,
    )
    .canonicalize()?;
    let name = std::ffi::CString::new(volume.as_os_str().as_encoded_bytes())?;
    let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
    anyhow::ensure!(
        unsafe { libc::statfs(name.as_ptr(), &mut stats) } == 0,
        "Cannot inspect quota volume"
    );
    let block_size = u64::try_from(stats.f_bsize)?;
    let capacity = stats.f_blocks * block_size;
    let available = stats.f_bavail * block_size;
    anyhow::ensure!(
        stats.f_type == libc::TMPFS_MAGIC
            && capacity <= 64 * 1024 * 1024
            && available >= 28 * 1024 * 1024,
        "Use an empty dedicated 32 MiB tmpfs; this test never fills an ordinary disk"
    );

    let workspace = tempfile::tempdir_in(volume)?;
    let root = workspace.path().join("data ทดสอบ");
    for directory in ["runtimes", "downloads", "staging"] {
        std::fs::create_dir_all(root.join(directory))?;
    }
    let offline = tempfile::tempdir()?;
    let archive = offline.path().join("fixture.zip");
    let block = [0u8; 1024 * 1024];
    {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive)?);
        zip.start_file(
            "bin/fixture",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )?;
        for _ in 0..16 {
            zip.write_all(&block)?;
        }
        zip.finish()?;
    }
    let checksum = hex::encode(Sha256::digest(std::fs::read(&archive)?));
    std::fs::rename(&archive, offline.path().join(&checksum))?;
    let mut manager = runtime::RuntimeManager::new(root.clone(), Arc::new(|_| {}));
    manager.catalog.artifacts = vec![RuntimeArtifact {
        id: "disk-full-fixture".into(),
        component: "fixture".into(),
        version: "1.0.0".into(),
        platform: runtime::PLATFORM.into(),
        arch: runtime::ARCH.into(),
        url: "https://example.invalid/disk-full-fixture".into(),
        sha256: checksum.clone(),
        archive: "zip".into(),
        strip_components: 0,
        executables: BTreeMap::from([("fixture".into(), "bin/fixture".into())]),
        license: "MIT".into(),
        source_url: "https://example.invalid/source".into(),
        size: std::fs::metadata(offline.path().join(&checksum))?.len(),
    }];
    let filler = workspace.path().join("owned-space-reservation");
    {
        let mut file = std::fs::File::create(&filler)?;
        for _ in 0..24 {
            file.write_all(&block)?;
        }
        file.sync_all()?;
    }
    let result: Result<()> = manager
        .install(
            "disk-full-fixture",
            "quota-failure",
            Some(offline.path().into()),
        )
        .await;
    let error = result.expect_err("The bounded filesystem should run out of space");
    anyhow::ensure!(
        error.chain().any(|cause| cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.raw_os_error() == Some(libc::ENOSPC))),
        "Expected a real ENOSPC failure, received: {error:#}"
    );
    anyhow::ensure!(
        !manager.list()[0].installed,
        "Failed installation was published"
    );
    anyhow::ensure!(
        manager.resolve("fixture", "1.0.0", "fixture").is_err(),
        "Partial executable was available"
    );
    anyhow::ensure!(
        std::fs::read_dir(root.join("staging"))?.next().is_none(),
        "Staging files were left behind"
    );
    std::fs::remove_file(filler)?;
    manager
        .install(
            "disk-full-fixture",
            "quota-retry",
            Some(offline.path().into()),
        )
        .await?;
    let executable = manager.resolve("fixture", "1.0.0", "fixture")?;
    anyhow::ensure!(
        std::fs::metadata(executable)?.len() == 16 * 1024 * 1024,
        "Retry lost runtime content"
    );
    println!("PASS actual ENOSPC: no installed receipt, no executable resolution, staging cleaned, same archive succeeds after freeing owned space");
    Ok(())
}
