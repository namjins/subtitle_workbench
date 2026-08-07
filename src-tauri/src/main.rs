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
    invocations.push(("subtitle-workbench".to_string(), ui_args(vec![])));
    invocations
}

fn spawn_bridge(port: u16) -> Result<Child, String> {
    let mut failures = Vec::new();
    for (program, args) in bridge_invocations(port) {
        // stdin is a pipe we never write to: the bridge watches it and exits
        // when it closes, which happens however this process dies — including
        // SIGKILL, where our own exit handler never runs.
        match Command::new(&program)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(error) => failures.push(format!("{program}: {error}")),
        }
    }
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
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Subtitle Workbench")
                .inner_size(1240.0, 860.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
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
