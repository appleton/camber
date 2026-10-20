//! User-local production control endpoint. It reuses the desktop's helper;
//! neither discovering an instance nor connecting to it starts another helper.
#[cfg(unix)]
use std::sync::Mutex;

use tauri::{App, Manager};

#[derive(Default)]
pub(crate) struct ControlState {
    #[cfg(unix)]
    server: Mutex<Option<unix::Server>>,
}

impl ControlState {
    pub(crate) fn helper_env(
        &self,
        helper_path: Option<std::ffi::OsString>,
    ) -> Vec<(String, String)> {
        #[cfg(unix)]
        if let Some(server) = self.server.lock().unwrap().as_ref() {
            let mut env = vec![
                ("CAMBER_INSTANCE_ID".into(), server.instance_id.clone()),
                (
                    "CAMBER_CONTROL_DIR".into(),
                    server.discovery_dir.to_string_lossy().into_owned(),
                ),
            ];
            // Packaged builds ship the CLI beside the app executable. Development
            // downloads stage an unsuffixed CLI alongside the helper binaries.
            let mut search_paths: Vec<_> = helper_path
                .as_ref()
                .map(|path| std::env::split_paths(path).collect())
                .unwrap_or_default();
            if let Ok(executable) = std::env::current_exe() {
                if let Some(parent) = executable.parent() {
                    if parent.join("poolside").is_file() {
                        search_paths.push(parent.to_path_buf());
                    }
                }
            }
            if cfg!(debug_assertions) {
                let binaries = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
                if binaries.join("poolside").is_file() {
                    search_paths.push(binaries);
                }
            }
            if let Ok(path) = std::env::join_paths(search_paths) {
                env.push(("PATH".into(), path.to_string_lossy().into_owned()));
            }
            return env;
        }
        // A desktop launched from an existing agent must never pass that
        // agent's instance identity through when its own endpoint is unavailable.
        vec![("CAMBER_INSTANCE_ID".into(), String::new())]
    }

    pub(crate) fn shutdown(&self) {
        #[cfg(unix)]
        self.server.lock().unwrap().take();
    }
}

pub(crate) fn start_on_setup(app: &mut App) {
    #[cfg(unix)]
    match unix::Server::start(app.handle().clone()) {
        Ok(server) => *app.state::<ControlState>().server.lock().unwrap() = Some(server),
        Err(error) => eprintln!("production control endpoint unavailable: {error}"),
    }
    #[cfg(not(unix))]
    let _ = app;
}

#[cfg(unix)]
mod unix {
    use std::{
        fs::{self, DirBuilder, File, OpenOptions},
        io::{self, BufRead, BufReader, Read, Write},
        os::{
            fd::AsRawFd,
            unix::{
                fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
                net::{UnixListener, UnixStream},
            },
        },
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::Duration,
    };

    use serde_json::{json, Value};
    use tauri::{async_runtime, AppHandle, Manager};

    const MAX_FRAME_BYTES: usize = 1024 * 1024;
    const MAX_CONNECTIONS: usize = 64;
    const IO_TIMEOUT: Duration = Duration::from_secs(30);
    const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

    pub(super) struct Server {
        pub(super) instance_id: String,
        pub(super) discovery_dir: PathBuf,
        socket_path: PathBuf,
        discovery_path: PathBuf,
        stop: Arc<AtomicBool>,
    }

    impl Server {
        pub(super) fn start(app: AppHandle) -> io::Result<Self> {
            let discovery_dir = discovery_dir()?;
            let uid = unsafe { libc::geteuid() };
            let socket_dir = PathBuf::from(format!("/tmp/poolside-control-{uid}"));
            let version = app.package_info().version.to_string();
            Self::bind(
                &discovery_dir,
                &socket_dir,
                &version,
                move |request, identity| {
                    async_runtime::block_on(async {
                        let id = request.get("id").cloned().unwrap_or(Value::Null);
                        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                        let (helper_ready, bridge_ready) = app
                            .state::<crate::helper::HelperState>()
                            .control_readiness()
                            .await;
                        if matches!(
                            method,
                            "camber/control/handshake" | "camber/control/status"
                        ) {
                            let mut status = identity.clone();
                            status["helperReady"] = json!(helper_ready);
                            status["notificationBridgeReady"] = json!(bridge_ready);
                            status["ready"] = json!(helper_ready && bridge_ready);
                            return success(id, status);
                        }
                        if !helper_ready || !bridge_ready {
                            let mut response = failure(id, -32002, "Desktop app is not ready");
                            response["error"]["data"] = json!({"code":"APP_NOT_READY"});
                            return response;
                        }
                        let params = request.get("params").cloned().unwrap_or(json!({}));
                        match tokio::time::timeout(
                        REQUEST_TIMEOUT,
                        crate::helper::send_helper_request(&app, method, params),
                    )
                    .await
                    {
                        Ok(Ok(result)) => success(id, result),
                        Ok(Err(error)) => {
                            let mut error = error.to_jsonrpc_value();
                            if error.get("code").is_none() {
                                error["code"] = json!(-32000);
                            }
                            json!({"jsonrpc":"2.0", "id":id, "error":error})
                        }
                        Err(_) => failure(
                            id,
                            -32003,
                            "Control request timed out; inspect state before retrying a mutation",
                        ),
                    }
                    })
                },
            )
        }

        fn bind(
            discovery_dir: &Path,
            socket_dir: &Path,
            version: &str,
            dispatch: impl Fn(Value, &Value) -> Value + Send + Sync + 'static,
        ) -> io::Result<Self> {
            private_dir(discovery_dir)?;
            private_dir(socket_dir)?;
            let instance_id = random_id()?;
            let socket_path = socket_dir.join(format!("{instance_id}.sock"));
            let discovery_path = discovery_dir.join(format!("{instance_id}.json"));
            let listener = UnixListener::bind(&socket_path)?;
            fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
            listener.set_nonblocking(true)?;
            let identity = json!({
                "protocolVersion": 1,
                "instanceId": instance_id,
                "pid": std::process::id(),
                "startedAt": chrono::Utc::now().to_rfc3339(),
                "socketPath": socket_path,
                "appVersion": version,
            });
            let stop = Arc::new(AtomicBool::new(false));
            let server = Self {
                instance_id,
                discovery_dir: discovery_dir.to_path_buf(),
                socket_path,
                discovery_path,
                stop: stop.clone(),
            };
            // Publish discovery only after bind succeeds. A unique random identity
            // prevents stale files or PID reuse from addressing a new instance.
            let temporary_path = server.discovery_path.with_extension("tmp");
            let mut record = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary_path)?;
            serde_json::to_writer(&mut record, &identity)?;
            record.write_all(b"\n")?;
            fs::rename(&temporary_path, &server.discovery_path)?;
            let dispatch = Arc::new(dispatch);
            thread::Builder::new()
                .name("camber-control".into())
                .spawn(move || {
                    let active = Arc::new(AtomicUsize::new(0));
                    while !stop.load(Ordering::Acquire) {
                        match listener.accept() {
                            Ok((mut stream, _)) => {
                                // Accepted sockets may inherit the nonblocking listener
                                // flag on Unix. Workers use bounded blocking I/O.
                                if stream.set_nonblocking(false).is_err() {
                                    continue;
                                }
                                if !peer_is_current_user(&stream).unwrap_or(false) {
                                    continue;
                                }
                                if active.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
                                    active.fetch_sub(1, Ordering::AcqRel);
                                    let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
                                    if let Err(error) = write_response(
                                        &mut stream,
                                        &failure(Value::Null, -32005, "Camber control is busy; retry when a connection is available"),
                                    ) {
                                        eprintln!("failed to report busy control endpoint: {error}");
                                    }
                                    continue;
                                }
                                let active = active.clone();
                                let dispatch = dispatch.clone();
                                let identity = identity.clone();
                                // A fixed connection limit and bounded reads prevent a
                                // local client from allocating unbounded workers or frames.
                                if let Err(error) = thread::Builder::new()
                                    .name("camber-control-client".into())
                                    .spawn(move || {
                                        let _guard = ConnectionGuard(active);
                                        let _ = serve(stream, &identity, &*dispatch);
                                    })
                                {
                                    // Spawn failure is exceptional; stop accepting rather
                                    // than allowing inaccurate connection accounting.
                                    eprintln!("failed to spawn control client: {error}");
                                    break;
                                }
                            }
                            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(50));
                            }
                            Err(error) => {
                                eprintln!("control listener failed: {error}");
                                break;
                            }
                        }
                    }
                })?;
            Ok(server)
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            let _ = fs::remove_file(&self.discovery_path);
            let _ = fs::remove_file(self.discovery_path.with_extension("tmp"));
            let _ = fs::remove_file(&self.socket_path);
        }
    }

    struct ConnectionGuard(Arc<AtomicUsize>);
    impl Drop for ConnectionGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }

    fn discovery_dir() -> io::Result<PathBuf> {
        if let Some(path) = std::env::var_os("CAMBER_CONTROL_DIR") {
            return Ok(PathBuf::from(path));
        }
        let home = std::env::var_os("HOME")
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;
        #[cfg(target_os = "macos")]
        return Ok(PathBuf::from(home).join("Library/Application Support/Camber/control"));
        #[cfg(not(target_os = "macos"))]
        return Ok(std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home).join(".local/state"))
            .join("camber/control"));
    }

    fn private_dir(path: &Path) -> io::Result<()> {
        match DirBuilder::new().recursive(true).mode(0o700).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Control directory must be owned by the current user with mode 0700",
            ));
        }
        Ok(())
    }

    fn random_id() -> io::Result<String> {
        let mut bytes = [0u8; 16];
        File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    fn peer_is_current_user(stream: &UnixStream) -> io::Result<bool> {
        #[cfg(target_os = "macos")]
        {
            let mut uid = 0;
            let mut gid = 0;
            if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(uid == unsafe { libc::geteuid() })
        }
        #[cfg(target_os = "linux")]
        {
            let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
            let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    &mut credentials as *mut _ as *mut libc::c_void,
                    &mut len,
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(credentials.uid == unsafe { libc::geteuid() })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = stream;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Peer credentials unsupported",
            ))
        }
    }

    fn serve(
        mut stream: UnixStream,
        identity: &Value,
        dispatch: &impl Fn(Value, &Value) -> Value,
    ) -> io::Result<()> {
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        loop {
            let mut frame = Vec::new();
            let length = reader
                .by_ref()
                .take((MAX_FRAME_BYTES + 1) as u64)
                .read_until(b'\n', &mut frame)?;
            if length == 0 {
                return Ok(());
            }
            if length > MAX_FRAME_BYTES || frame.last() != Some(&b'\n') {
                write_response(
                    &mut stream,
                    &failure(Value::Null, -32600, "Invalid or oversized control frame"),
                )?;
                return Ok(());
            }
            let response = match serde_json::from_slice::<Value>(&frame) {
                Ok(request) => match validate(&request, identity) {
                    Ok(()) => dispatch(request, identity),
                    Err(response) => response,
                },
                Err(_) => failure(Value::Null, -32700, "Invalid JSON"),
            };
            write_response(&mut stream, &response)?;
        }
    }

    fn validate(request: &Value, identity: &Value) -> Result<(), Value> {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        if !matches!(id, Value::Number(_) | Value::String(_))
            || request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        {
            return Err(failure(
                id,
                -32600,
                "Expected a JSON-RPC 2.0 request with an id",
            ));
        }
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            method,
            "camber/control/handshake" | "camber/control/status" | "camber/control/dispatch"
        ) {
            return Err(failure(id, -32601, "Control method not found"));
        }
        if method != "camber/control/handshake"
            && request.get("instanceId") != identity.get("instanceId")
        {
            return Err(failure(
                id,
                -32001,
                "Desktop instance identity does not match discovery",
            ));
        }
        Ok(())
    }

    fn write_response(stream: &mut UnixStream, response: &Value) -> io::Result<()> {
        serde_json::to_writer(&mut *stream, response)?;
        stream.write_all(b"\n")
    }

    fn success(id: Value, result: Value) -> Value {
        json!({"jsonrpc":"2.0", "id":id, "result":result})
    }

    fn failure(id: Value, code: i64, message: &str) -> Value {
        json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn request(method: &str) -> Value {
            json!({"jsonrpc":"2.0", "id":1,"method":method,"instanceId":"expected"})
        }

        #[test]
        fn requests_require_identity_and_only_expose_control_methods() {
            let identity = json!({"instanceId":"expected"});
            assert!(validate(&request("camber/control/dispatch"), &identity).is_ok());
            let mut stale = request("camber/control/dispatch");
            stale["instanceId"] = json!("stale");
            assert_eq!(
                validate(&stale, &identity).unwrap_err()["error"]["code"],
                -32001
            );
            assert_eq!(
                validate(&request("camber/jsonrpc/request"), &identity).unwrap_err()["error"]
                    ["code"],
                -32601
            );
            let mut handshake = request("camber/control/handshake");
            handshake.as_object_mut().unwrap().remove("instanceId");
            assert!(validate(&handshake, &identity).is_ok());
        }

        #[test]
        fn frames_are_bounded_and_multiple_requests_work() {
            let (server, mut client) = UnixStream::pair().unwrap();
            let worker = thread::spawn(move || {
                serve(server, &json!({"instanceId":"expected"}), &|request, _| {
                    success(request["id"].clone(), json!({"helperReady":false}))
                })
            });
            client.write_all(b"not-json\n").unwrap();
            let mut reader = BufReader::new(client.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap()["error"]["code"],
                -32700
            );
            write_response(&mut client, &request("camber/control/handshake")).unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap()["result"]["helperReady"],
                false
            );
            client.write_all(&vec![b'x'; MAX_FRAME_BYTES + 1]).unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap()["error"]["code"],
                -32600
            );
            worker.join().unwrap().unwrap();
        }

        #[test]
        fn directory_security_peer_credentials_and_discovery_cleanup() {
            let dir = PathBuf::from("/tmp").join(format!("pct-{}", &random_id().unwrap()[..12]));
            let discovery = dir.join("discovery");
            let sockets = dir.join("sockets");
            let server = Server::bind(&discovery, &sockets, "1.2.3", |request, identity| {
                success(request["id"].clone(), identity.clone())
            })
            .unwrap();
            assert_eq!(fs::metadata(&discovery).unwrap().mode() & 0o777, 0o700);
            assert_eq!(
                fs::metadata(&server.discovery_path).unwrap().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&server.socket_path).unwrap().mode() & 0o777,
                0o600
            );
            let mut client = UnixStream::connect(&server.socket_path).unwrap();
            assert!(peer_is_current_user(&client).unwrap());
            // Allow the accept loop to run before the request arrives. A
            // nonblocking accepted socket would close on WouldBlock here.
            thread::sleep(Duration::from_millis(150));
            write_response(
                &mut client,
                &json!({"jsonrpc":"2.0","id":1,"method":"camber/control/handshake"}),
            )
            .unwrap();
            let mut response = String::new();
            BufReader::new(client).read_line(&mut response).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["result"]["instanceId"],
                server.instance_id
            );
            let record: Value =
                serde_json::from_reader(File::open(&server.discovery_path).unwrap()).unwrap();
            assert_eq!(record["instanceId"], server.instance_id);
            assert!(
                chrono::DateTime::parse_from_rfc3339(record["startedAt"].as_str().unwrap()).is_ok()
            );
            assert_eq!(record["appVersion"], "1.2.3");
            let record_path = server.discovery_path.clone();
            let socket_path = server.socket_path.clone();
            drop(server);
            assert!(!record_path.exists());
            assert!(!socket_path.exists());
            fs::set_permissions(&discovery, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                private_dir(&discovery).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn saturated_endpoint_returns_busy_without_disappearing() {
            let dir = PathBuf::from("/tmp").join(format!("pcb-{}", &random_id().unwrap()[..12]));
            let server = Server::bind(
                &dir.join("discovery"),
                &dir.join("sockets"),
                "test",
                |request, identity| success(request["id"].clone(), identity.clone()),
            )
            .unwrap();
            let mut clients = Vec::new();
            for _ in 0..MAX_CONNECTIONS {
                let mut client = UnixStream::connect(&server.socket_path).unwrap();
                client
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                write_response(
                    &mut client,
                    &json!({"jsonrpc":"2.0","id":1,"method":"camber/control/handshake"}),
                )
                .unwrap();
                let mut response = String::new();
                BufReader::new(client.try_clone().unwrap())
                    .read_line(&mut response)
                    .unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&response).unwrap()["result"]["instanceId"],
                    server.instance_id
                );
                clients.push(client);
            }
            let client = UnixStream::connect(&server.socket_path).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut response = String::new();
            BufReader::new(client).read_line(&mut response).unwrap();
            let response: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(response["error"]["code"], -32005);
            assert!(response["id"].is_null());
            drop(clients);
            drop(server);
            fs::remove_dir_all(dir).unwrap();
        }
    }
}
