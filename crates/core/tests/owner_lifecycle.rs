use stackcabin_core::{models::ProcessState, process::OwnedProcess, store::atomic_write};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tempfile::TempDir;

const FIXTURE: &str = "lifecycle_fixture";

#[derive(serde::Serialize, serde::Deserialize)]
struct Tree {
    port: u16,
    launcher: u32,
    worker: u32,
}

struct ProcessProbe {
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
    #[cfg(unix)]
    pid: u32,
}

impl ProcessProbe {
    fn new(pid: u32) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(!handle.is_null(), "Could not observe fixture process {pid}");
            Self {
                handle: unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) },
            }
        }
        #[cfg(unix)]
        {
            Self { pid }
        }
    }

    fn running(&self) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{
                Foundation::WAIT_TIMEOUT, System::Threading::WaitForSingleObject,
            };
            let result = unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) };
            assert!(
                result == WAIT_TIMEOUT || result == 0,
                "Could not query fixture process handle"
            );
            result == WAIT_TIMEOUT
        }
        #[cfg(unix)]
        {
            let output = std::process::Command::new("ps")
                .args(["-p", &self.pid.to_string(), "-o", "stat="])
                .output()
                .expect("Could not query fixture process state");
            assert!(
                output.status.success() || output.status.code() == Some(1),
                "ps failed"
            );
            let state = String::from_utf8(output.stdout).unwrap();
            let state = state.trim();
            // Adopted Unix zombies have exited and cannot execute or hold a
            // listening socket; the OS's reaper controls their final removal.
            !state.is_empty() && !state.starts_with(['Z', 'X'])
        }
    }
}

fn fixture_command(role: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--ignored", "--exact", FIXTURE, "--nocapture"])
        .env("STACKCABIN_LIFECYCLE_ROLE", role)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    command
}

async fn response(client: &reqwest::Client, port: u16) -> Option<String> {
    client
        .get(format!("http://127.0.0.1:{port}"))
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()
}

#[tokio::test]
async fn owner_crash_reaps_multiple_trees_and_preserves_unrelated_process() {
    let temp = TempDir::new().unwrap();
    let workspace = temp.path().join("owner crash ทดสอบ");
    std::fs::create_dir(&workspace).unwrap();
    let ready = workspace.join("ready.json");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();

    // This server is a separate process, outside either owned tree. Keep its
    // actual child handle until cleanup, so the assertion cannot pass on a
    // replacement process that happened to acquire the same PID or port.
    let foreign_port = stackcabin_core::process::available_port(0).await.unwrap();
    let mut foreign = fixture_command("worker")
        .env("STACKCABIN_LIFECYCLE_PORT", foreign_port.to_string())
        .env("STACKCABIN_LIFECYCLE_BODY", "unrelated server")
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        while response(&client, foreign_port).await.as_deref() != Some("unrelated server") {
            assert!(
                foreign.try_wait().unwrap().is_none(),
                "Unrelated fixture exited before readiness"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("Unrelated fixture did not become healthy");
    let mut owner = fixture_command("owner")
        .env("STACKCABIN_LIFECYCLE_READY", &ready)
        .current_dir(&workspace)
        .spawn()
        .unwrap();

    let result = async {
        tokio::time::timeout(Duration::from_secs(15), async {
            while !ready.is_file() {
                assert!(
                    owner.try_wait().unwrap().is_none(),
                    "Owner exited before readiness"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("Owner did not start both real HTTP grandchildren");
        let trees: Vec<Tree> = serde_json::from_slice(&std::fs::read(&ready).unwrap()).unwrap();
        assert_eq!(trees.len(), 2);
        let probes: Vec<_> = trees
            .iter()
            .flat_map(|tree| [tree.launcher, tree.worker])
            .map(ProcessProbe::new)
            .collect();
        assert!(
            probes.iter().all(ProcessProbe::running),
            "Fixture process exited before the crash"
        );
        for (index, tree) in trees.iter().enumerate() {
            assert_eq!(
                response(&client, tree.port).await,
                Some(format!("owned tree {index}"))
            );
        }
        assert_eq!(
            response(&client, foreign_port).await.as_deref(),
            Some("unrelated server")
        );
        // Terminate only the supervisor host. No Rust destructor, stop, poll or
        // group/tree termination runs in it; OS ownership must close both trees.
        owner.start_kill().unwrap();
        let status = owner.wait().await.unwrap();
        assert!(!status.success(), "Fixture owner must exit abruptly");
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let mut listening = false;
                for tree in &trees {
                    listening |= tokio::net::TcpStream::connect(("127.0.0.1", tree.port))
                        .await
                        .is_ok();
                }
                if !listening && probes.iter().all(|probe| !probe.running()) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("Supervisor crash left an owned process running or listening");
        assert!(
            foreign.try_wait().unwrap().is_none(),
            "Unrelated process was terminated"
        );
        assert_eq!(
            response(&client, foreign_port).await.as_deref(),
            Some("unrelated server")
        );
        println!("Owner crash closed both HTTP ports and stopped all four owned descendants; unrelated process stayed healthy");
    };
    // Cleanup also runs on assertion failure. Fixture descendants have a finite
    // lifetime as a second bound if an ownership regression leaves one behind.
    let checked = std::panic::AssertUnwindSafe(result);
    use futures_util::FutureExt;
    let result = checked.catch_unwind().await;
    let _ = owner.kill().await;
    let _ = foreign.kill().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

// A single ignored entry point supplies real owner, launcher and HTTP worker
// subprocesses. It is invoked only by the acceptance test above.
#[test]
#[ignore]
fn lifecycle_fixture() {
    let lifetime = Duration::from_secs(40);
    match std::env::var("STACKCABIN_LIFECYCLE_ROLE").unwrap().as_str() {
        "worker" => {
            #[cfg(unix)]
            unsafe {
                libc::signal(libc::SIGTERM, libc::SIG_IGN);
            }
            let port: u16 = std::env::var("STACKCABIN_LIFECYCLE_PORT")
                .unwrap()
                .parse()
                .unwrap();
            let body = std::env::var("STACKCABIN_LIFECYCLE_BODY").unwrap();
            let listener = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
            listener.set_nonblocking(true).unwrap();
            if let Some(file) = std::env::var_os("STACKCABIN_LIFECYCLE_PID_FILE") {
                atomic_write(Path::new(&file), std::process::id().to_string().as_bytes()).unwrap();
            }
            let deadline = std::time::Instant::now() + lifetime;
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
                        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => panic!("Fixture HTTP accept failed: {error}"),
                }
            }
        }
        "launcher" => {
            let mut worker = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", FIXTURE, "--nocapture"])
                .env("STACKCABIN_LIFECYCLE_ROLE", "worker")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            // This deliberately does not wrap the worker in another owned job
            // or watchdog. Its owner must contain descendants automatically.
            let _ = worker.wait();
        }
        "owner" => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let mut processes = Vec::new();
                let mut trees = Vec::new();
                for index in 0..2 {
                    let port = stackcabin_core::process::available_port(0).await.unwrap();
                    let worker_pid_file = std::env::current_dir()
                        .unwrap()
                        .join(format!("worker-{index}.pid"));
                    let mut process = OwnedProcess::spawn(
                        &std::env::current_exe().unwrap(),
                        &[
                            "--ignored".into(),
                            "--exact".into(),
                            FIXTURE.into(),
                            "--nocapture".into(),
                        ],
                        Path::new("."),
                        &BTreeMap::from([
                            ("STACKCABIN_LIFECYCLE_ROLE".into(), "launcher".into()),
                            ("STACKCABIN_LIFECYCLE_PORT".into(), port.to_string()),
                            (
                                "STACKCABIN_LIFECYCLE_PID_FILE".into(),
                                worker_pid_file.to_string_lossy().into_owned(),
                            ),
                            (
                                "STACKCABIN_LIFECYCLE_BODY".into(),
                                format!("owned tree {index}"),
                            ),
                        ]),
                        &format!("owned-{index}"),
                        "crash-acceptance",
                        Arc::new(|_| {}),
                    )
                    .await
                    .unwrap();
                    process.ready(port, true).await.unwrap();
                    assert_eq!(process.info.state, ProcessState::Running);
                    trees.push(Tree {
                        port,
                        launcher: process.info.pid.unwrap(),
                        worker: std::fs::read_to_string(worker_pid_file)
                            .unwrap()
                            .parse()
                            .unwrap(),
                    });
                    processes.push(process);
                }
                let ready = std::env::var_os("STACKCABIN_LIFECYCLE_READY").unwrap();
                atomic_write(Path::new(&ready), &serde_json::to_vec(&trees).unwrap()).unwrap();
                tokio::time::sleep(lifetime).await;
                // Only a failed test reaches this fallback; the normal probe
                // kills the owner while all OwnedProcess instances are alive.
                for process in &mut processes {
                    process.stop().await;
                }
            });
        }
        role => panic!("Unknown lifecycle fixture role: {role}"),
    }
}
