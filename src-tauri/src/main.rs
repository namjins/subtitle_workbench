// The desktop app is a thin shell: it starts the same Node bridge the web
// workbench uses (`subtitle-workbench ui`) on a private port and opens a
// window on it. Everything of substance — job queue, authorization token,
// native file picking, progress streaming — already lives in the bridge,
// which was deliberately built in this shape. The shell's only jobs are to
// own the bridge process's lifetime and to fail with instructions a
// non-expert can follow.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

struct BridgeChild(Mutex<Option<Child>>);

/// Ask the OS for a free ephemeral port. Racy in principle (the port is
/// released before the bridge binds it), but the bridge fails loudly on a
/// bind error rather than serving from somewhere unexpected.
fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// How to start the CLI, most specific first: an explicit override, the
/// repository checkout this dev build sits in, then a globally installed
/// `subtitle-workbench` (`npm install -g subtitle-workbench`), which is the
/// expected shape for an installed app under the user-installed-tools model.
fn bridge_invocations(port: u16) -> Vec<(String, Vec<String>)> {
    let ui_args = |mut head: Vec<String>| {
        head.extend(
            ["ui", "--no-open", "--exit-with-parent", "--port"]
                .iter()
                .map(|s| s.to_string()),
        );
        head.push(port.to_string());
        head
    };

    let mut invocations = Vec::new();
    if let Ok(cli) = std::env::var("SUBTITLE_WORKBENCH_CLI") {
        invocations.push(("node".to_string(), ui_args(vec![cli])));
    }
    let dev_cli = concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/subtitle-workbench.mjs");
    if std::path::Path::new(dev_cli).exists() {
        invocations.push(("node".to_string(), ui_args(vec![dev_cli.to_string()])));
    }
    if cfg!(windows) {
        // A global npm install on Windows writes subtitle-workbench.cmd — no
        // .exe — and CreateProcessW only ever appends .exe to a bare name, so
        // the invocation below this one can never find it there.
        invocations.push(("subtitle-workbench.cmd".to_string(), ui_args(vec![])));
    }
    invocations.push(("subtitle-workbench".to_string(), ui_args(vec![])));
    invocations
}

/// A double-clicked app inherits the login session's PATH, not the shell's:
/// on macOS that is /usr/bin:/bin:/usr/sbin:/sbin, with no Homebrew, no nvm,
/// no volta — so the Node a terminal user demonstrably has is invisible here.
/// Prepend the standard install roots; directories that do not exist are
/// harmless, and anything already on PATH still resolves as before.
fn augmented_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut roots: Vec<String> = Vec::new();
    if cfg!(unix) {
        roots.push("/opt/homebrew/bin".into());
        roots.push("/usr/local/bin".into());
        if let Ok(home) = std::env::var("HOME") {
            roots.push(format!("{home}/.volta/bin"));
            // nvm keeps one directory per Node version; take the newest.
            if let Ok(entries) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
                let mut versions: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
                versions.sort();
                if let Some(newest) = versions.last() {
                    roots.push(format!("{}/bin", newest.display()));
                }
            }
        }
    }
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            roots.push(format!("{appdata}\\npm"));
        }
    }
    let separator = if cfg!(windows) { ";" } else { ":" };
    roots.push(current);
    roots.join(separator)
}

fn spawn_bridge(port: u16) -> Result<Child, String> {
    let path = augmented_path();
    let mut failures = Vec::new();
    for (program, args) in bridge_invocations(port) {
        // stdin is a pipe we never write to: the bridge watches it and exits
        // when it closes, which happens however this process dies — including
        // SIGKILL, where our own exit handler never runs.
        match Command::new(&program)
            .args(&args)
            .env("PATH", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(error) => failures.push(format!("{program}: {error}")),
        }
    }
    // The effective PATH is the single most useful diagnostic here: the usual
    // cause is a GUI launch that never saw the shell profile's additions.
    failures.push(format!("searched PATH: {path}"));
    Err(failures.join("\n"))
}

fn wait_for_bridge(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Written for someone who has never used a terminal before this app.
const NODE_HELP: &str = "Subtitle Workbench could not start its conversion engine.\n\n\
    It needs Node.js and the subtitle-workbench command installed:\n\n\
    1. Install Node.js from https://nodejs.org (choose the LTS version).\n\
    2. Open the Terminal app and run:  npm install -g subtitle-workbench\n\
    3. Start Subtitle Workbench again.\n\n\
    Run `subtitle-workbench doctor` in the Terminal to check the remaining tools.";

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let port = free_port()?;
            let child = match spawn_bridge(port) {
                Ok(child) => child,
                Err(details) => {
                    app.dialog()
                        .message(format!("{NODE_HELP}\n\nDetails:\n{details}"))
                        .kind(MessageDialogKind::Error)
                        .title("Conversion engine not found")
                        .blocking_show();
                    return Err(details.into());
                }
            };
            app.manage(BridgeChild(Mutex::new(Some(child))));

            if !wait_for_bridge(port, Duration::from_secs(20)) {
                app.dialog()
                    .message(NODE_HELP)
                    .kind(MessageDialogKind::Error)
                    .title("Conversion engine did not start")
                    .blocking_show();
                return Err("bridge did not start listening".into());
            }

            let url = format!("http://127.0.0.1:{port}/")
                .parse()
                .expect("bridge URL is always valid");

            // The measured natural size of the tallest tool at the wide
            // two-column layout: opening at this size shows every tool
            // without scrollbars or spare right-hand margin. Clamped to the
            // monitor — with headroom for the menu bar / task bar, which the
            // reported monitor size includes — so a small screen gets a
            // window that fits it instead.
            let mut width: f64 = 1380.0;
            let mut height: f64 = 930.0;
            if let Ok(Some(monitor)) = app.primary_monitor() {
                let scale = monitor.scale_factor();
                let logical_width = monitor.size().width as f64 / scale;
                let logical_height = monitor.size().height as f64 / scale;
                width = width.min(logical_width - 20.0).max(800.0);
                height = height.min(logical_height - 80.0).max(600.0);
                eprintln!(
                    "window sizing: monitor physical {:?} scale {} -> logical {}x{} -> window {}x{}",
                    monitor.size(),
                    scale,
                    logical_width,
                    logical_height,
                    width,
                    height,
                );
            }

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Subtitle Workbench")
                .inner_size(width, height)
                .min_inner_size(900.0, 600.0)
                .center()
                // Tauri's own drag-drop handler swallows HTML5 drop events;
                // the page implements drops itself, so hand them through.
                .disable_drag_drop_handler()
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        // Not .expect(): under windows_subsystem = "windows" a panic has no
        // console to print to, and the user-facing dialog has already shown.
        .unwrap_or_else(|error| {
            eprintln!("error while building tauri application: {error}");
            std::process::exit(1);
        })
        .run(|app, event| {
            // The bridge must not outlive its window: it can read and write
            // files and spawn processes, so an orphaned copy listening on
            // localhost is exactly what the threat model forbids.
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<BridgeChild>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}
