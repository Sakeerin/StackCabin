use crate::{
    models::*,
    runtime::{EventSink, RuntimeManager},
    store::{atomic_write, within},
};
use anyhow::{Context, Result};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpListener,
    process::{Child, Command},
    sync::Mutex,
};

pub struct OwnedProcess {
    child: Child,
    pub info: ProcessInfo,
    #[cfg(windows)]
    job: isize,
    #[cfg(unix)]
    _watchdog: Option<std::os::fd::OwnedFd>,
}
#[cfg(windows)]
unsafe impl Send for OwnedProcess {}

impl OwnedProcess {
    pub async fn spawn(
        program: &Path,
        args: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
        name: &str,
        subject: &str,
        sink: EventSink,
    ) -> Result<Self> {
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000 | 0x00000200);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("Could not launch {}", program.display()))?;
        #[cfg(windows)]
        let job = unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::{JobObjects::*, Threading::*};
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            anyhow::ensure!(!job.is_null(), "Could not create process job");
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            );
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                0,
                child.id().context("Missing process id")?,
            );
            let assigned = if process.is_null() {
                0
            } else {
                AssignProcessToJobObject(job, process)
            };
            if !process.is_null() {
                CloseHandle(process);
            }
            if configured == 0 || assigned == 0 {
                CloseHandle(job);
                let _ = child.start_kill();
                anyhow::bail!("Could not contain child process in a Windows Job Object");
            }
            job as isize
        };
        let pid = child.id();
        #[cfg(unix)]
        let watchdog = unix_watchdog(pid.context("Missing process id")?)?;
        let secrets: Vec<_> = env
            .iter()
            .filter(|(key, value)| !value.is_empty() && crate::store::sensitive_key(key))
            .map(|(_, value)| value.clone())
            .collect();
        let redacted_sink: EventSink = Arc::new(move |mut event| {
            for secret in &secrets {
                event.message = event.message.replace(secret, "[redacted]");
            }
            sink(event);
        });
        if let Some(stdout) = child.stdout.take() {
            pipe_log(stdout, name, subject, "stdout", redacted_sink.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            pipe_log(stderr, name, subject, "stderr", redacted_sink);
        }
        Ok(Self {
            child,
            info: ProcessInfo {
                name: name.into(),
                pid,
                state: ProcessState::Starting,
                port: None,
                url: None,
                error: None,
            },
            #[cfg(windows)]
            job,
            #[cfg(unix)]
            _watchdog: Some(watchdog),
        })
    }
    pub fn poll(&mut self) {
        if matches!(
            self.info.state,
            ProcessState::Stopped | ProcessState::Failed
        ) {
            return;
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.info.state = ProcessState::Failed;
                self.info.error = Some(format!("Process exited: {status}"));
            }
            Err(e) => {
                self.info.state = ProcessState::Failed;
                self.info.error = Some(e.to_string());
            }
            _ => {}
        }
        if self.info.state == ProcessState::Failed {
            #[cfg(windows)]
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 1);
            }
            #[cfg(unix)]
            self._watchdog.take(); // EOF makes the guard terminate its own group.
        }
    }
    pub async fn ready(&mut self, port: u16, http: bool) -> Result<()> {
        self.ready_path(port, http, "/").await
    }
    pub async fn ready_path(&mut self, port: u16, http: bool, path: &str) -> Result<()> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        while tokio::time::Instant::now() < deadline {
            self.poll();
            anyhow::ensure!(
                self.info.state != ProcessState::Failed,
                "{}",
                self.info.error.as_deref().unwrap_or("Process exited")
            );
            let available = if http {
                client
                    .get(format!("http://127.0.0.1:{port}{path}"))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().as_u16() < 500)
            } else {
                tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .is_ok()
            };
            if available {
                self.info.state = ProcessState::Running;
                self.info.port = Some(port);
                if http {
                    self.info.url = Some(format!("http://127.0.0.1:{port}"));
                }
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        anyhow::bail!("{} did not become healthy on port {port} within 60 seconds. Check Logs and install dependencies.",self.info.name)
    }
    pub async fn stop(&mut self) {
        self.info.state = ProcessState::Stopping;
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job as _, 0);
        }
        if tokio::time::timeout(Duration::from_secs(8), self.child.wait())
            .await
            .is_err()
        {
            #[cfg(unix)]
            if let Some(pid) = self.child.id() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = self.child.kill().await;
        }
        self.info.state = ProcessState::Stopped;
        self.info.pid = None;
        self.info.url = None;
    }
    pub async fn wait(&mut self) -> Result<()> {
        let status = self.child.wait().await?;
        anyhow::ensure!(
            status.success(),
            "Command failed: {status}. See Logs for details."
        );
        Ok(())
    }
}

#[cfg(unix)]
fn unix_watchdog(group: u32) -> Result<std::os::fd::OwnedFd> {
    use std::os::fd::FromRawFd;
    // The forked guard executes only async-signal-safe libc functions. It joins
    // the owned group, keeping that PGID alive and preventing PID-reuse kills.
    unsafe {
        let mut fds = [0; 2];
        anyhow::ensure!(
            libc::pipe(fds.as_mut_ptr()) == 0,
            "Could not create watchdog pipe"
        );
        for fd in fds {
            if libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
                libc::close(fds[0]);
                libc::close(fds[1]);
                anyhow::bail!("Could not protect watchdog pipe from child inheritance");
            }
        }
        let max_fd = libc::sysconf(libc::_SC_OPEN_MAX).max(256) as i32;
        let pid = libc::fork();
        if pid < 0 {
            libc::close(fds[0]);
            libc::close(fds[1]);
            anyhow::bail!("Could not fork process watchdog");
        }
        if pid == 0 {
            libc::close(fds[1]);
            if libc::setpgid(0, group as i32) != 0 {
                libc::_exit(0);
            }
            for fd in 3..max_fd {
                if fd != fds[0] {
                    libc::close(fd);
                }
            }
            let mut byte = 0u8;
            loop {
                let count = libc::read(fds[0], &mut byte as *mut u8 as *mut _, 1);
                if count == 0 {
                    libc::kill(-(group as i32), libc::SIGKILL);
                    libc::_exit(0);
                }
                if count < 0 {
                    libc::_exit(0);
                }
            }
        }
        libc::close(fds[0]);
        // Reap the guard separately; it is deliberately not a user-visible service.
        std::thread::spawn(move || {
            let mut status = 0;
            libc::waitpid(pid, &mut status, 0);
        });
        Ok(std::os::fd::OwnedFd::from_raw_fd(fds[1]))
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

fn pipe_log<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    reader: R,
    name: &str,
    subject: &str,
    stream: &str,
    sink: EventSink,
) {
    let name = name.to_string();
    let subject = subject.to_string();
    let stream = stream.to_string();
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(16384)]);
                    (sink)(event(
                        "log",
                        "",
                        &subject,
                        format!("[{name}:{stream}] {}", text.trim_end()),
                        None,
                    ));
                }
            }
        }
    });
}

pub async fn available_port(preferred: u16) -> Result<u16> {
    if preferred >= 1024 {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", preferred)).await {
            return Ok(listener.local_addr()?.port());
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    Ok(listener.local_addr()?.port())
}

struct ProjectRun {
    processes: Vec<OwnedProcess>,
    static_info: Option<ProcessInfo>,
    url: Option<String>,
    fallback_url: Option<String>,
}
#[derive(Clone)]
struct ProxyRoute {
    named: serde_json::Value,
    direct: serde_json::Value,
    port: u16,
}
struct Proxy {
    process: OwnedProcess,
    port: u16,
    admin: u16,
}
pub struct Supervisor {
    projects: Mutex<BTreeMap<String, ProjectRun>>,
    services: Mutex<BTreeMap<String, OwnedProcess>>,
    proxy: Mutex<Option<Proxy>>,
    routes: Mutex<BTreeMap<String, ProxyRoute>>,
    operations: Mutex<BTreeMap<String, tokio_util::sync::CancellationToken>>,
    transition: Mutex<()>,
    runtime: Arc<RuntimeManager>,
    sink: EventSink,
    root: PathBuf,
}
impl Supervisor {
    pub fn new(root: PathBuf, runtime: Arc<RuntimeManager>, sink: EventSink) -> Self {
        Self {
            projects: Default::default(),
            services: Default::default(),
            proxy: Default::default(),
            routes: Default::default(),
            operations: Default::default(),
            transition: Default::default(),
            runtime,
            sink,
            root,
        }
    }
    pub async fn statuses(&self) -> Vec<ProjectStatus> {
        let proxy_failed = self.proxy.lock().await.as_mut().is_some_and(|proxy| {
            proxy.process.poll();
            proxy.process.info.state == ProcessState::Failed
        });
        self.projects
            .lock()
            .await
            .iter_mut()
            .map(|(id, run)| {
                for p in &mut run.processes {
                    p.poll();
                }
                let mut processes: Vec<_> = run.processes.iter().map(|p| p.info.clone()).collect();
                if let Some(info) = &run.static_info {
                    processes.push(info.clone());
                }
                if proxy_failed {
                    processes.push(ProcessInfo {
                        name: "local-proxy".into(),
                        pid: None,
                        state: ProcessState::Failed,
                        port: None,
                        url: None,
                        error: Some("Caddy stopped unexpectedly. Restart the project.".into()),
                    });
                }
                ProjectStatus {
                    project_id: id.clone(),
                    processes,
                    url: run.url.clone(),
                    fallback_url: run.fallback_url.clone(),
                }
            })
            .collect()
    }
    pub async fn is_active(&self, id: &str) -> bool {
        self.projects.lock().await.get(id).is_some_and(|r| {
            r.static_info
                .as_ref()
                .is_some_and(|p| !matches!(p.state, ProcessState::Failed | ProcessState::Stopped))
                || r.processes
                    .iter()
                    .any(|p| !matches!(p.info.state, ProcessState::Failed | ProcessState::Stopped))
        })
    }
    pub fn environment(&self, project: &Project) -> Result<BTreeMap<String, String>> {
        let mut environment = project.spec.environment.clone();
        let mut directories = vec![];
        for selection in &project.spec.runtimes {
            let tool = if selection.component == "php" {
                "php"
            } else {
                "node"
            };
            let executable =
                self.runtime
                    .resolve(&selection.component, &selection.version, tool)?;
            directories.push(executable.parent().unwrap().to_path_buf());
            if selection.component == "php" {
                environment.insert(
                    "PHPRC".into(),
                    self.runtime
                        .php_ini(&selection.version)?
                        .to_string_lossy()
                        .into(),
                );
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            directories.extend(std::env::split_paths(&path));
        }
        environment.insert(
            "PATH".into(),
            std::env::join_paths(directories)?.to_string_lossy().into(),
        );
        environment.insert("HOST".into(), "127.0.0.1".into());
        environment.insert("HOSTNAME".into(), "127.0.0.1".into());
        environment.insert("PHP_FCGI_MAX_REQUESTS".into(), "0".into());
        for (key, relative) in [
            ("npm_config_cache", "downloads/npm-cache"),
            ("COMPOSER_HOME", "services/composer"),
            ("COMPOSER_CACHE_DIR", "downloads/composer-cache"),
            ("YARN_CACHE_FOLDER", "downloads/yarn-cache"),
        ] {
            let path = self.root.join(relative);
            std::fs::create_dir_all(&path)?;
            environment.insert(key.into(), path.to_string_lossy().into());
        }
        Ok(environment)
    }
    pub fn tool(&self, project: &Project, tool: &str) -> Result<(PathBuf, Vec<String>)> {
        let component = if ["php", "composer", "php-cgi", "php-fpm"].contains(&tool) {
            "php"
        } else {
            "node"
        };
        let selection = project
            .spec
            .runtimes
            .iter()
            .find(|r| r.component == component)
            .context(format!("Select a {component} runtime for this project"))?;
        if tool == "composer" {
            return Ok((
                self.runtime.resolve("php", &selection.version, "php")?,
                vec![self
                    .runtime
                    .latest_installed("composer", "composer")?
                    .to_string_lossy()
                    .into()],
            ));
        }
        if ["npm", "pnpm", "yarn"].contains(&tool) {
            let node = self.runtime.resolve("node", &selection.version, "node")?;
            let script = if tool == "npm" {
                self.runtime.resolve("node", &selection.version, "npm")?
            } else {
                self.runtime.latest_installed(tool, tool)?
            };
            return Ok((node, vec![script.to_string_lossy().into()]));
        }
        Ok((
            self.runtime.resolve(component, &selection.version, tool)?,
            vec![],
        ))
    }
    pub async fn start(&self, project: &Project, proxy_port: u16) -> Result<ProjectStatus> {
        let _transition = self.transition.lock().await;
        anyhow::ensure!(
            project.trusted,
            "Trust this project before executing its code"
        );
        anyhow::ensure!(
            !self.is_active(&project.id).await,
            "Project is already running"
        );
        self.stop_inner(&project.id).await;
        let caddy = self.runtime.latest_installed("caddy", "caddy")?;
        let root = dunce::canonicalize(&project.path)?;
        let mut environment = self.environment(project)?;
        let mut run = ProjectRun {
            processes: vec![],
            static_info: None,
            url: None,
            fallback_url: None,
        };
        self.projects.lock().await.insert(
            project.id.clone(),
            ProjectRun {
                processes: vec![],
                static_info: Some(ProcessInfo {
                    name: "web".into(),
                    pid: None,
                    state: ProcessState::Starting,
                    port: None,
                    url: None,
                    error: None,
                }),
                url: None,
                fallback_url: None,
            },
        );
        (self.sink)(event("state", "", &project.id, "Starting project", None));
        let result:Result<()>=async{
            let mut route=None;
            for spec in &project.spec.processes{
                let port=available_port(spec.port.unwrap_or(3000)).await?;
                environment.insert("PORT".into(),port.to_string());
                if spec.tool=="static"{
                    route=Some(serde_json::json!({"handle":[{"handler":"vars","root":root.to_string_lossy()},{"handler":"file_server","hide":[".git",".env","stackcabin.json","stackcabin.lock.json"]}]}));
                    run.static_info=Some(ProcessInfo{name:spec.name.clone(),pid:None,state:ProcessState::Starting,port:None,url:None,error:None});continue;
                }
                let cwd=within(&root,&spec.cwd)?;
                let (program,mut args)=if spec.tool=="php-web"{
                    let document_root=if project.spec.preset==Preset::Laravel{root.join("public")}else{root.clone()};
                    anyhow::ensure!(document_root.is_dir(),"PHP document root is missing. Install dependencies first.");
                    let tool=if cfg!(windows){"php-cgi"}else{"php-fpm"};
                    let (program,mut args)=self.tool(project,tool)?;
                    if cfg!(windows){args.extend(["-b".into(),format!("127.0.0.1:{port}"),"-d".into(),"cgi.force_redirect=0".into()]);}
                    else {
                        let config=self.root.join("services").join(format!("php-{}-{}.conf",project.id,spec.name));
                        let config_text=format!("[global]\ndaemonize = no\nerror_log = /dev/stderr\n[www]\nlisten = 127.0.0.1:{port}\nlisten.allowed_clients = 127.0.0.1\npm = ondemand\npm.max_children = 4\ncatch_workers_output = yes\nclear_env = no\n");
                        atomic_write(&config,config_text.as_bytes())?;args.extend(["-F".into(),"-y".into(),config.to_string_lossy().into()]);
                    }
                    route=Some(php_route(&document_root,port));(program,args)
                }else{
                    let (program,mut args)=self.tool(project,&spec.tool)?;
                    args.extend(spec.args.iter().map(|s|s.replace("${PORT}",&port.to_string())));
                    if route.is_none(){route=Some(serde_json::json!({"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":format!("127.0.0.1:{port}")}]}]}));}
                    (program,args)
                };
                let mut process=OwnedProcess::spawn(&program,&args,&cwd,&environment,&spec.name,&project.id,self.sink.clone()).await?;
                args.clear();
                let healthy=process.ready_path(port,spec.tool!="php-web",spec.health_path.as_deref().unwrap_or("/")).await;
                if let Err(error)=healthy {process.stop().await;return Err(error);}
                run.processes.push(process);
            }
            let mut route=route.context("Add at least one web process")?;
            let slug=crate::project::slug(&project.spec.name).chars().take(42).collect::<String>();
            let host=format!("{}-{}.localhost",slug.trim_end_matches('-'),&project.id[..8]);
            let direct=route.clone();
            let fallback_port=available_port(0).await?;
            route["match"]=serde_json::json!([{"host":[&host,format!("{}.localhost",project.id)]}]);
            self.routes.lock().await.insert(project.id.clone(),ProxyRoute{named:route,direct,port:fallback_port});
            let port=self.update_proxy(&caddy,proxy_port).await?;
            let url=format!("http://{host}:{port}");
            // Check the routed request, not a timer, before publishing Running.
            let response=reqwest::Client::new().get(format!("http://127.0.0.1:{port}/")).header("Host",format!("{}.localhost",project.id)).send().await?;
            anyhow::ensure!(response.status().as_u16()<500,"Web route returned {}. See Logs.",response.status());
            if let Some(info)=&mut run.static_info{info.state=ProcessState::Running;info.port=Some(port);info.url=Some(url.clone());}
            run.url=Some(url);run.fallback_url=Some(format!("http://127.0.0.1:{fallback_port}"));Ok(())
        }.await;
        if let Err(error) = result {
            for process in &mut run.processes {
                process.stop().await;
            }
            self.routes.lock().await.remove(&project.id);
            run.static_info = Some(ProcessInfo {
                name: "web".into(),
                pid: None,
                state: ProcessState::Failed,
                port: None,
                url: None,
                error: Some(format!("{error:#}")),
            });
            self.projects.lock().await.insert(project.id.clone(), run);
            (self.sink)(event("error", "", &project.id, format!("{error:#}"), None));
            return Err(error);
        }
        self.projects.lock().await.insert(project.id.clone(), run);
        (self.sink)(event("state", "", &project.id, "Project is running", None));
        self.statuses()
            .await
            .into_iter()
            .find(|s| s.project_id == project.id)
            .context("Project state unavailable")
    }
    async fn update_proxy(&self, caddy: &Path, preferred: u16) -> Result<u16> {
        let mut proxy = self.proxy.lock().await;
        if let Some(p) = proxy.as_mut() {
            p.process.poll();
            if p.process.info.state == ProcessState::Failed {
                *proxy = None;
            }
        }
        let (port, admin) = if let Some(p) = proxy.as_ref() {
            (p.port, p.admin)
        } else {
            (
                available_port(preferred).await?,
                available_port(20190).await?,
            )
        };
        let routes = self.routes.lock().await.clone();
        let named: Vec<_> = routes.values().map(|route| route.named.clone()).collect();
        let mut servers = serde_json::json!({"local":{"listen":[format!("127.0.0.1:{port}")],"routes":named,"automatic_https":{"disable":true}}});
        for (id, route) in routes {
            servers[format!("loopback-{id}")] = serde_json::json!({"listen":[format!("127.0.0.1:{}",route.port)],"routes":[route.direct],"automatic_https":{"disable":true}});
        }
        let config = serde_json::json!({"admin":{"listen":format!("127.0.0.1:{admin}"),"config":{"persist":false}},"storage":{"module":"file_system","root":self.root.join("services/caddy-storage").to_string_lossy()},"apps":{"http":{"servers":servers}}});
        let path = self.root.join("services/caddy.json");
        atomic_write(&path, &serde_json::to_vec_pretty(&config)?)?;
        if proxy.is_some() {
            reqwest::Client::new()
                .post(format!("http://127.0.0.1:{admin}/load"))
                .json(&config)
                .send()
                .await?
                .error_for_status()?;
        } else {
            let caddy_environment = BTreeMap::from([
                (
                    "XDG_CONFIG_HOME".into(),
                    self.root
                        .join("services/caddy-config")
                        .to_string_lossy()
                        .into(),
                ),
                (
                    "XDG_DATA_HOME".into(),
                    self.root
                        .join("services/caddy-data")
                        .to_string_lossy()
                        .into(),
                ),
                (
                    "APPDATA".into(),
                    self.root
                        .join("services/caddy-appdata")
                        .to_string_lossy()
                        .into(),
                ),
            ]);
            let mut process = OwnedProcess::spawn(
                caddy,
                &[
                    "run".into(),
                    "--config".into(),
                    path.to_string_lossy().into(),
                ],
                &self.root,
                &caddy_environment,
                "caddy",
                "service:caddy",
                self.sink.clone(),
            )
            .await?;
            process.ready(port, false).await?;
            *proxy = Some(Proxy {
                process,
                port,
                admin,
            });
        }
        Ok(port)
    }
    async fn stop_inner(&self, id: &str) {
        if let Some(mut run) = self.projects.lock().await.remove(id) {
            for process in run.processes.iter_mut().rev() {
                process.stop().await;
            }
        }
        self.routes.lock().await.remove(id);
    }
    pub async fn stop(&self, id: &str) -> Result<()> {
        let _transition = self.transition.lock().await;
        self.stop_inner(id).await;
        if self.routes.lock().await.is_empty() {
            if let Some(mut proxy) = self.proxy.lock().await.take() {
                proxy.process.stop().await;
            }
        } else if let Ok(caddy) = self.runtime.latest_installed("caddy", "caddy") {
            if self.proxy.lock().await.is_some() {
                self.update_proxy(&caddy, 8080).await?;
            }
        }
        (self.sink)(event("state", "", id, "Project stopped", None));
        Ok(())
    }
    pub async fn run_task(
        &self,
        project: &Project,
        tool: &str,
        args: &[String],
        operation: &str,
    ) -> Result<()> {
        anyhow::ensure!(
            project.trusted,
            "Trust this project before installing dependencies"
        );
        let token = tokio_util::sync::CancellationToken::new();
        self.operations
            .lock()
            .await
            .insert(operation.into(), token.clone());
        let result=async {
            let (program,mut prefix)=self.tool(project,tool)?;prefix.extend_from_slice(args);
            let mut process=OwnedProcess::spawn(&program,&prefix,Path::new(&project.path),&self.environment(project)?,"dependencies",&project.id,self.sink.clone()).await?;
            tokio::select!{result=process.wait()=>result,_=token.cancelled()=>{process.stop().await;anyhow::bail!("Operation cancelled")}}
        }.await;
        self.operations.lock().await.remove(operation);
        result
    }
    pub async fn cancel(&self, id: &str) {
        if let Some(token) = self.operations.lock().await.get(id) {
            token.cancel();
        }
    }
    pub async fn start_service(
        &self,
        id: &str,
        program: &Path,
        args: &[String],
        environment: &BTreeMap<String, String>,
        port: u16,
    ) -> Result<()> {
        let mut services = self.services.lock().await;
        if let Some(process) = services.get_mut(id) {
            process.poll();
            if process.info.state == ProcessState::Running {
                return Ok(());
            }
        }
        let mut process = OwnedProcess::spawn(
            program,
            args,
            &self.root,
            environment,
            id,
            &format!("service:{id}"),
            self.sink.clone(),
        )
        .await?;
        if let Err(error) = process.ready(port, false).await {
            process.stop().await;
            return Err(error);
        }
        services.insert(id.into(), process);
        Ok(())
    }
    pub async fn service_state(&self, id: &str) -> ProcessState {
        if id == "caddy" {
            return self
                .proxy
                .lock()
                .await
                .as_mut()
                .map(|p| {
                    p.process.poll();
                    p.process.info.state.clone()
                })
                .unwrap_or(ProcessState::Stopped);
        }
        self.services
            .lock()
            .await
            .get_mut(id)
            .map(|p| {
                p.poll();
                p.info.state.clone()
            })
            .unwrap_or(ProcessState::Stopped)
    }
    pub async fn proxy_port(&self) -> Option<u16> {
        self.proxy.lock().await.as_ref().map(|p| p.port)
    }
    pub async fn stop_service(&self, id: &str) {
        if let Some(mut process) = self.services.lock().await.remove(id) {
            process.stop().await;
        }
    }
    pub async fn shutdown(&self) {
        let ids: Vec<_> = self.projects.lock().await.keys().cloned().collect();
        for id in ids {
            self.stop_inner(&id).await;
        }
        let ids: Vec<_> = self.services.lock().await.keys().cloned().collect();
        for id in ids {
            self.stop_service(&id).await;
        }
        if let Some(mut proxy) = self.proxy.lock().await.take() {
            proxy.process.stop().await;
        }
    }
}

fn php_route(root: &Path, port: u16) -> serde_json::Value {
    serde_json::json!({"handle":[{"handler":"subroute","routes":[
        {"handle":[{"handler":"vars","root":root.to_string_lossy()}]},
        {"match":[{"path":["/.env*","/.git/*","/stackcabin.json","/stackcabin.lock.json"]}],"handle":[{"handler":"static_response","status_code":404}]},
        {"match":[{"file":{"try_files":["{http.request.uri.path}","{http.request.uri.path}/index.php","index.php"],"split_path":[".php"]}}],"handle":[{"handler":"rewrite","uri":"{http.matchers.file.relative}"}]},
        {"match":[{"path":["*.php"]}],"handle":[{"handler":"reverse_proxy","transport":{"protocol":"fastcgi","split_path":[".php"],"root":root.to_string_lossy()},"upstreams":[{"dial":format!("127.0.0.1:{port}")}]}]},
        {"handle":[{"handler":"file_server"}]}
    ]}]})
}
