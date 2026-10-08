#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Constellation desktop: a Tauri shell around the Command Center. It starts the bundled daemon
// (node.exe next to this exe running the server bundle under resources/), waits until the API
// answers, and points its one window at the daemon's own URL. The dashboard then runs exactly
// as it does in a browser: same origin, same service worker, same offline copy, no IPC. The api
// token is handed over in the URL fragment the way scripts/mockup.mjs does it. Updates come from
// GitHub releases through the Tauri updater. The plan and decisions are in
// initiatives/desktop-app.md.

mod daemon;

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use daemon::NewWindow;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// The daemon this app started, owned from the moment it is spawned, so closing the window while
/// the start page still shows stops it too. Empty when the app found one already running on the
/// port with this database's token (the logon task, or `cc daemon` in a terminal): that one is
/// used and left alone on exit. Once the app is closing, nothing more is started.
#[derive(Default)]
struct Daemon(Mutex<Owned>);

#[derive(Default)]
struct Owned {
    child: Option<Child>,
    closing: bool,
}

/// What the start page should be showing: the shell's last status line and its error, if any.
/// The start thread speaks from the moment the window exists, which can be before the page's
/// script has defined setStatus and showError (an impostor on the port answers in milliseconds),
/// so each is kept here and said again once the page has finished loading.
#[derive(Default)]
struct StartPage(Mutex<StartPageState>);

#[derive(Default)]
struct StartPageState {
    status: Option<String>,
    error: Option<String>,
}

impl StartPage {
    fn lock(&self) -> std::sync::MutexGuard<'_, StartPageState> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// How the daemon being started is doing, as the start thread sees it.
enum Running {
    Yes,
    Exited(std::process::ExitStatus),
    /// Stopped by this app: it is closing, or installing an update.
    Stopped,
}

impl Daemon {
    // A panic while the lock was held must not stop the exit handler from killing the child.
    fn lock(&self) -> std::sync::MutexGuard<'_, Owned> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts the command and keeps the child, under the same lock the exit handler takes, so a
    /// child is either owned or never started. None when the app is already closing.
    fn spawn(&self, command: &mut Command) -> std::io::Result<Option<u32>> {
        let mut owned = self.lock();
        if owned.closing {
            return Ok(None);
        }
        let child = command.spawn()?;
        let pid = child.id();
        owned.child = Some(child);
        Ok(Some(pid))
    }

    fn running(&self) -> Running {
        let mut owned = self.lock();
        let Some(child) = owned.child.as_mut() else { return Running::Stopped };
        match child.try_wait() {
            Ok(Some(status)) => {
                owned.child = None;
                Running::Exited(status)
            }
            _ => Running::Yes,
        }
    }

    /// Kills the child this app started, if any, and waits for it. `closing` also stops anything
    /// being started afterwards.
    fn stop(&self, closing: bool) {
        let mut owned = self.lock();
        owned.closing |= closing;
        if let Some(mut child) = owned.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

const START_TIMEOUT: Duration = Duration::from_secs(60);
const UPDATE_CHECK_DELAY: Duration = Duration::from_secs(3);
const LOG_TAIL_LINES: usize = 20;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn main() {
    // Everything the shell says goes to desktop.log next to the database (a windowed process has
    // no console), including a panic on the start thread, which would otherwise vanish.
    let app_log = daemon::app_log_file(&db_path());
    let _ = fs::create_dir_all(app_log.parent().unwrap_or_else(|| Path::new(".")));
    let _ = fs::write(&app_log, "");
    let panic_log = app_log.clone();
    std::panic::set_hook(Box::new(move |info| log_line(&panic_log, &format!("panic: {info}"))));
    log_line(&app_log, &format!("Constellation {} starting", env!("CARGO_PKG_VERSION")));

    tauri::Builder::default()
        // A second launch would start a second daemon on the same port. Focus the first instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(Daemon::default())
        .manage(StartPage::default())
        .setup(|app| {
            let handle = app.handle().clone();
            main_window(&handle)?;
            thread::spawn(move || start(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build the Constellation app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Daemon>().stop(true);
            }
        });
}

/// The database this app uses, with a relative CC_DB taken from the launch directory.
fn db_path() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    daemon::db_path(&|name| std::env::var(name).ok(), &cwd)
}

/// The one window, built here rather than by tauri.conf.json (where it is marked create: false)
/// so that it has a new-window handler. Without one, WebView2 swallows every target=_blank link,
/// window.open, and form aimed at a new window, which is how the GitHub setup, sign-in, and task
/// links open. daemon::new_window decides where each one goes.
fn main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .expect("tauri.conf.json defines the main window");
    let opener = app.clone();
    WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(move |url, _features| match daemon::new_window(&url) {
            NewWindow::Popup => NewWindowResponse::Allow,
            NewWindow::Browser => {
                if let Err(e) = opener.opener().open_url(url.as_str(), None::<&str>) {
                    log_line(&daemon::app_log_file(&db_path()), &format!("could not open {} in the browser: {e}", url.origin().ascii_serialization()));
                }
                NewWindowResponse::Deny
            }
            NewWindow::Refuse => NewWindowResponse::Deny,
        })
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                replay_start_page(&window);
            }
        })
        .build()
}

fn start(app: AppHandle) {
    let app_log = daemon::app_log_file(&db_path());
    let Some(window) = app.get_webview_window("main") else {
        log_line(&app_log, "no main window");
        return;
    };
    match boot(&app, &window, &app_log) {
        Ok(url) => {
            log_line(&app_log, &format!("opening {}", url.origin().ascii_serialization()));
            if let Err(e) = window.navigate(url) {
                let message = format!("Could not open the dashboard: {e}");
                log_line(&app_log, &message);
                show_error(&window, &message);
                return;
            }
            let handle = app.clone();
            thread::spawn(move || {
                thread::sleep(UPDATE_CHECK_DELAY);
                check_for_update(handle, &app_log);
            });
        }
        Err(message) => {
            log_line(&app_log, &message);
            show_error(&window, &message);
        }
    }
}

fn log_line(path: &Path, text: &str) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{stamp} {text}");
    }
}

/// The updater enables rustls-no-provider on our shared reqwest dependency, even though
/// this client only uses HTTP. Install the same provider the updater uses before the first
/// client is built; an error just means another caller already installed a provider.
fn daemon_client() -> Result<reqwest::Client, reqwest::Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // This is called from a plain thread; client construction needs a Tokio reactor.
    // The updater also enables system proxies, which must not intercept the loopback probe.
    tauri::async_runtime::block_on(async {
        reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build()
    })
}

/// Finds or starts the daemon and returns the URL to open. Every failure is a sentence for the
/// start page, with the log's last lines when the daemon itself said something.
fn boot(app: &AppHandle, window: &WebviewWindow, app_log: &Path) -> Result<url::Url, String> {
    let env = |name: &str| std::env::var(name).ok();
    let port = daemon::port(&env)?;
    let db = db_path();
    log_line(app_log, &format!("port {port}, database {}", db.display()));
    let data_dir = db.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&data_dir).map_err(|e| format!("Could not create {}: {e}", data_dir.display()))?;
    let token_file = daemon::token_file(&db);
    let client = daemon_client().map_err(|e| e.to_string())?;

    set_status(window, "Looking for a running Command Center...");
    // Resolved every time it is needed, the way the daemon resolves it: an override in the
    // environment the daemon inherits, or the file the daemon writes.
    let resolve_token = || daemon::api_token(&env, fs::read_to_string(&token_file).ok());
    let token = resolve_token();
    match probe(&client, port, token.as_deref().unwrap_or("")) {
        Probe::Healthy => {
            log_line(app_log, "a Command Center is already running on the port; using it");
            let token = token.ok_or("the server answered without a token, which cannot happen")?;
            return parse_url(daemon::handoff_url(port, &token));
        }
        refused @ (Probe::Refused(_) | Probe::Impostor) => return Err(port_in_use(port, &refused, &db)),
        Probe::Unreachable => {}
    }

    set_status(window, "Starting the Command Center...");
    let resources = resource_root(app)?;
    log_line(app_log, &format!("resources {}", resources.display()));
    let script = resources.join("command-center").join("src").join("bundle").join("cli.mjs");
    let dashboard = resources.join("dist");
    let node = node_exe()?;
    for (what, path) in [("server bundle", script.clone()), ("dashboard", dashboard.join("index.html")), ("node.exe", node.clone())] {
        if !path.exists() {
            return Err(format!("The {what} is missing from this install: {}. Reinstall Constellation.", path.display()));
        }
    }

    let log = daemon::log_file(&db);
    rotate_log(&log);
    let out = File::create(&log).map_err(|e| format!("Could not write {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let has_repo_root = env("CC_REPO_ROOT").is_some_and(|v| !v.trim().is_empty());

    let mut command = Command::new(&node);
    command
        .args(daemon::daemon_args(&script, port, has_repo_root))
        .env("CC_DB", &db)
        .env("CC_DASHBOARD_DIR", &dashboard)
        .current_dir(&data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let owner = app.state::<Daemon>();
    let pid = match owner.spawn(&mut command) {
        Ok(Some(pid)) => pid,
        Ok(None) => return Err(CLOSING.to_string()),
        Err(e) => return Err(format!("Could not start {}: {e}", node.display())),
    };
    log_line(app_log, &format!("started {} (pid {pid}), log {}", node.display(), log.display()));

    let started = Instant::now();
    let token = loop {
        match owner.running() {
            Running::Yes => {}
            Running::Exited(status) => {
                return Err(format!("The Command Center stopped right after starting ({status}).\n\n{}", log_tail(&log)));
            }
            Running::Stopped => return Err(CLOSING.to_string()),
        }
        if let Some(token) = resolve_token() {
            if let Probe::Healthy = probe(&client, port, &token) {
                break token;
            }
        }
        if started.elapsed() > START_TIMEOUT {
            owner.stop(false);
            return Err(format!(
                "The Command Center did not answer on port {port} within {} seconds.\n\n{}",
                START_TIMEOUT.as_secs(),
                log_tail(&log)
            ));
        }
        thread::sleep(Duration::from_millis(250));
    };
    parse_url(daemon::handoff_url(port, &token))
}

const CLOSING: &str = "Constellation is closing.";

enum Probe {
    /// The port answered the identity challenge with the proof only the holder of this
    /// database's api token can compute: this is the Command Center to use.
    Healthy,
    /// Something answered on the port, but not with 2xx: not a Command Center at all, or one that
    /// does not know the route.
    Refused(u16),
    /// Something answered 2xx without the right proof: a Command Center with another token, a
    /// program that happens to answer everything, or a process pretending. Whatever it is, the
    /// token is not sent to it and the window is not pointed at it.
    Impostor,
    Unreachable,
}

/// Asks the port to prove it holds the api token before the token, or the window, goes anywhere
/// near it. Until this check the shell sent the token as a bearer credential to whatever answered
/// and took any 2xx for the daemon, so another account that bound the port while the daemon was
/// stopped would have collected the token and then had the whole dashboard to serve. The proof
/// is an HMAC of a fresh challenge (daemon::identity_proof), which gives nothing away.
fn probe(client: &reqwest::Client, port: u16, token: &str) -> Probe {
    let challenge = fresh_challenge();
    let url = format!("http://127.0.0.1:{port}/api/identity?challenge={challenge}");
    // send() itself arms the timeout, so it has to run inside the runtime, not just its future.
    let answer = tauri::async_runtime::block_on(async {
        let response = client.get(&url).send().await?;
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        Ok::<(u16, String), reqwest::Error>((status, body))
    });
    match answer {
        Err(_) => Probe::Unreachable,
        Ok((status, _)) if !(200..300).contains(&status) => Probe::Refused(status),
        Ok((_, body)) => {
            let proof = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| value.get("proof")?.as_str().map(str::to_string));
            match proof {
                Some(proof) if !token.is_empty() && daemon::same_proof(&proof, &daemon::identity_proof(token, port, &challenge)) => Probe::Healthy,
                _ => Probe::Impostor,
            }
        }
    }
}

/// 32 random bytes as hex, new for every probe, so an answer recorded once is no use later.
fn fresh_challenge() -> String {
    let mut bytes = [0u8; 32];
    // The OS random source failing is not something to carry on from: a fixed challenge would
    // make a recorded answer replayable.
    getrandom::fill(&mut bytes).expect("the operating system's random source is unavailable");
    hex::encode(bytes)
}

fn port_in_use(port: u16, probe: &Probe, db: &Path) -> String {
    let what = match probe {
        Probe::Refused(status) => format!("Port {port} is already in use (HTTP {status}) by a server that is not a Command Center."),
        _ => format!("Port {port} is already in use by a server that did not prove it holds this database's token."),
    };
    format!(
        "{what}\n\n\
         If that is the Command Center logon task from the constellation repo, either stop it, or give both \
         the same database by setting the CC_DB user environment variable to its database file. This app is \
         using {}.\n\nTo run this app on another port instead, set CC_PORT.",
        db.display()
    )
}

fn check_for_update(app: AppHandle, app_log: &Path) {
    let Ok(updater) = app.updater() else { return };
    let update = match tauri::async_runtime::block_on(updater.check()) {
        Ok(Some(update)) => update,
        // No newer release, no feed yet, or no network: nothing to say on start.
        Ok(None) => {
            log_line(app_log, "update check: up to date");
            return;
        }
        Err(e) => {
            log_line(app_log, &format!("update check failed: {e}"));
            return;
        }
    };
    log_line(app_log, &format!("update available: {}", update.version));
    let message = format!(
        "Constellation {} is available. This is {}.\n\nInstall it now? The app closes, installs, and opens again.",
        update.version, update.current_version
    );
    let install = app
        .dialog()
        .message(message)
        .title("Update available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Install".to_string(), "Later".to_string()))
        .blocking_show();
    if !install {
        return;
    }
    // The installer replaces node.exe and the resources, so the daemon must not hold them open.
    app.state::<Daemon>().stop(true);
    if let Err(e) = tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
        log_line(app_log, &format!("update failed: {e}"));
        app.dialog()
            .message(format!("The update could not be installed: {e}\n\nConstellation opens again as it was."))
            .title("Update failed")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    }
    // On Windows the installer closes this process itself; this is for the failure path and for
    // any platform where install returns.
    app.restart();
}

fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().resource_dir().map_err(|e| format!("Could not find the app's resources: {e}"))?;
    Ok(daemon::strip_verbatim(&dir).join("resources"))
}

/// The sidecar from bundle.externalBin: `binaries/node-<triple>.exe` is installed as node.exe
/// next to this executable.
fn node_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("the app's own path has no folder")?;
    Ok(daemon::strip_verbatim(dir).join("node.exe"))
}

fn rotate_log(log: &Path) {
    let old = log.with_extension("log.old");
    let _ = fs::rename(log, old);
}

fn log_tail(log: &Path) -> String {
    let Ok(text) = fs::read_to_string(log) else {
        return format!("There is no log at {}.", log.display());
    };
    let lines: Vec<&str> = text.lines().collect();
    let tail = lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].join("\n");
    if tail.trim().is_empty() {
        format!("The log at {} is empty.", log.display())
    } else {
        format!("From {}:\n{tail}", log.display())
    }
}

fn parse_url(text: String) -> Result<url::Url, String> {
    url::Url::parse(&text).map_err(|e| format!("Bad dashboard URL {text}: {e}"))
}

/// The two functions the start page (desktop/ui/index.html) defines, said now and again when the
/// page finishes loading (replay_start_page). Both are guarded, so once the window has moved on
/// to the dashboard, where neither exists, nothing happens.
fn set_status(window: &WebviewWindow, text: &str) {
    window.state::<StartPage>().lock().status = Some(text.to_string());
    eval_status(window, text);
}

fn show_error(window: &WebviewWindow, text: &str) {
    window.state::<StartPage>().lock().error = Some(text.to_string());
    eval_error(window, text);
}

/// Says the last status and error again, for a page that has just finished loading. On the
/// dashboard neither function exists, so this does nothing there.
fn replay_start_page(window: &WebviewWindow) {
    let (status, error) = {
        let state = window.state::<StartPage>();
        let state = state.lock();
        (state.status.clone(), state.error.clone())
    };
    if let Some(text) = status {
        eval_status(window, &text);
    }
    if let Some(text) = error {
        eval_error(window, &text);
    }
}

fn eval_status(window: &WebviewWindow, text: &str) {
    let _ = window.eval(&format!("window.setStatus && window.setStatus({})", json(text)));
}

fn eval_error(window: &WebviewWindow, text: &str) {
    let _ = window.eval(&format!("window.showError && window.showError({})", json(text)));
}

fn json(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn client() -> reqwest::Client {
        daemon_client().expect("client")
    }

    /// A one-request HTTP server on a free port that answers with `respond(request_target)`.
    fn serve_once(respond: impl FnOnce(&str) -> String + Send + 'static) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let n = socket.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let target = request.split_whitespace().nth(1).unwrap_or("").to_string();
            let _ = socket.write_all(respond(&target).as_bytes());
        });
        port
    }

    fn http(status: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn probe_reports_a_closed_port_as_unreachable() {
        // Port 9 (discard) is never listened on locally.
        assert!(matches!(probe(&client(), 9, "token"), Probe::Unreachable));
    }

    #[test]
    fn probe_sends_no_token_and_accepts_only_the_right_proof() {
        let token = "test-api-token-0000000000000000";
        let port = serve_once(move |target| {
            assert!(target.starts_with("/api/identity?challenge="), "the probe asks for identity, got {target}");
            let challenge = &target["/api/identity?challenge=".len()..];
            assert_eq!(challenge.len(), 64, "a 32-byte challenge in hex");
            http("200 OK", &format!("{{\"proof\":\"{}\"}}", daemon::identity_proof(token, 0, challenge)))
        });
        // The server above signs for port 0, since it cannot know its port before it is bound;
        // the probe expects a proof for the port it connected to, so this one must fail...
        assert!(matches!(probe(&client(), port, token), Probe::Impostor));

        // ...and one bound to the port passes.
        let port_cell = std::sync::Arc::new(std::sync::atomic::AtomicU16::new(0));
        let for_server = port_cell.clone();
        let port = serve_once(move |target| {
            let challenge = &target["/api/identity?challenge=".len()..];
            let port = for_server.load(std::sync::atomic::Ordering::SeqCst);
            http("200 OK", &format!("{{\"proof\":\"{}\"}}", daemon::identity_proof(token, port, challenge)))
        });
        port_cell.store(port, std::sync::atomic::Ordering::SeqCst);
        assert!(matches!(probe(&client(), port, token), Probe::Healthy));
    }

    #[test]
    fn a_2xx_without_the_proof_is_an_impostor_and_a_non_2xx_is_refused() {
        let port = serve_once(|_| http("200 OK", "{\"ok\":true}"));
        assert!(matches!(probe(&client(), port, "token"), Probe::Impostor));
        let port = serve_once(|_| http("200 OK", "{\"proof\":\"0000\"}"));
        assert!(matches!(probe(&client(), port, "token"), Probe::Impostor));
        let port = serve_once(|_| http("401 Unauthorized", "{}"));
        assert!(matches!(probe(&client(), port, "token"), Probe::Refused(401)));
        // Without a token there is nothing to verify against, so a proof cannot be accepted.
        let port = serve_once(|_| http("200 OK", "{\"proof\":\"anything\"}"));
        assert!(matches!(probe(&client(), port, ""), Probe::Impostor));
    }

    /// Stands in for a daemon whose health answer has not come yet: a process that only waits.
    fn waiting_process() -> Command {
        let mut command = Command::new("ping");
        command.args(["-n", "60", "127.0.0.1"]).stdout(Stdio::null()).stderr(Stdio::null());
        command
    }

    #[cfg(windows)]
    fn process_alive(pid: u32) -> bool {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().expect("tasklist");
        String::from_utf8_lossy(&out.stdout).split_whitespace().any(|word| word == pid.to_string())
    }

    #[cfg(windows)]
    #[test]
    fn a_daemon_still_starting_is_stopped_when_the_app_closes() {
        let owner = Daemon::default();
        let pid = owner.spawn(&mut waiting_process()).expect("spawn").expect("not closing yet");
        assert!(matches!(owner.running(), Running::Yes));
        assert!(process_alive(pid));

        // What the exit handler does while the start page still shows.
        owner.stop(true);
        assert!(!process_alive(pid), "the child outlived the app");
        assert!(matches!(owner.running(), Running::Stopped));
        // And a start that loses the race with closing starts nothing.
        assert!(owner.spawn(&mut waiting_process()).expect("spawn").is_none());
    }

    #[test]
    fn a_daemon_found_running_is_not_owned_and_survives_close() {
        // Nothing was spawned, so there is nothing to stop: the found daemon is left alone.
        let owner = Daemon::default();
        assert!(matches!(owner.running(), Running::Stopped));
        owner.stop(true);
    }

    #[test]
    fn a_timeout_stops_the_child_but_not_the_app() {
        let owner = Daemon::default();
        owner.spawn(&mut waiting_process()).expect("spawn").expect("not closing");
        owner.stop(false);
        assert!(matches!(owner.running(), Running::Stopped));
        let pid = owner.spawn(&mut waiting_process()).expect("spawn").expect("a retry may still start one");
        assert!(pid > 0);
        owner.stop(true);
    }

    #[test]
    fn every_probe_uses_a_new_challenge() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        for _ in 0..2 {
            let seen = seen.clone();
            let port = serve_once(move |target| {
                seen.lock().unwrap().push(target.to_string());
                http("200 OK", "{}")
            });
            probe(&client(), port, "token");
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_ne!(seen[0], seen[1]);
    }
}
