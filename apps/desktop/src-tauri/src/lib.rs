// The Titlesearch desktop shell (CLAUDE.md: a thin Tauri 2 shell). It runs the
// titlesearch binary as a sidecar in serve mode and shows its UI. Everything
// the app does lives in that binary; the shell adds only what a desktop app
// needs: the keychain for the local token, a tray, start at login, and updates.
//
// How the webview signs in without a secret in a URL: the sidecar runs in
// desktop mode (TITLESEARCH_DESKTOP=1) and reports a one-time login code on its
// stdout pipe, which only this process reads. The webview gets the code
// through an initialization script and the UI submits it.
// See docs/decisions/0023-desktop-shell.md.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_updater::UpdaterExt;

const KEYCHAIN_SERVICE: &str = "com.prodxp.titlesearch";
const KEYCHAIN_ACCOUNT: &str = "local-token";
/// Passed by the login item, so starting at login doesn't open a window.
const HIDDEN_ARG: &str = "--hidden";
const MAIN: &str = "main";

#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    url: Mutex<Option<String>>,
    /// Open the window when the next login code arrives.
    open_on_code: Mutex<bool>,
}

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum SidecarEvent {
    Ready {
        url: String,
        #[serde(rename = "loginCode")]
        login_code: String,
    },
    Code {
        #[serde(rename = "loginCode")]
        login_code: String,
    },
    Token {
        token: String,
    },
    /// A key entered on the Providers page: save it, or delete it when null.
    Key {
        name: String,
        value: Option<String>,
    },
}

/// The keys the app keeps in the keychain, one entry each, named as the
/// environment variables the sidecar reads.
const KEY_NAMES: [&str; 5] = [
    "ANTHROPIC_API_KEY",
    "PORKBUN_API_KEY",
    "PORKBUN_SECRET_API_KEY",
    "NAMECOM_USERNAME",
    "NAMECOM_TOKEN",
];

/// The saved keys, to hand to the sidecar at launch.
fn keychain_keys() -> Vec<(&'static str, String)> {
    KEY_NAMES
        .iter()
        .filter_map(|name| {
            let entry = keyring::Entry::new(KEYCHAIN_SERVICE, name).ok()?;
            entry.get_password().ok().map(|v| (*name, v))
        })
        .collect()
}

fn store_key(name: &str, value: Option<&str>) {
    if !KEY_NAMES.contains(&name) {
        return;
    }
    let result = keyring::Entry::new(KEYCHAIN_SERVICE, name).and_then(|entry| match value {
        Some(v) => entry.set_password(v),
        None => match entry.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            other => other,
        },
    });
    // The key's name is logged, never its value.
    if let Err(e) = result {
        log::error!("Couldn't update {name} in the keychain: {e}");
    }
}

fn is_token(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random number generator failed");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The local server's bearer token, kept in the OS keychain (invariant 6).
fn keychain_token() -> Result<String, String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
    if let Ok(existing) = entry.get_password() {
        if is_token(&existing) {
            return Ok(existing);
        }
    }
    let token = new_token();
    entry.set_password(&token).map_err(|e| e.to_string())?;
    Ok(token)
}

fn store_token(token: &str) {
    if !is_token(token) {
        return;
    }
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(entry) => {
            if let Err(e) = entry.set_password(token) {
                log::error!("Couldn't save the new token to the keychain: {e}");
            }
        }
        Err(e) => log::error!("Couldn't open the keychain: {e}"),
    }
}

/// A free port on the loopback interface, for the sidecar.
fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}

fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let token = keychain_token()?;
    let port = free_port().map_err(|e| e.to_string())?;
    let (mut events, child) = app
        .shell()
        .sidecar("titlesearch")
        .map_err(|e| e.to_string())?
        .args(["serve", "--port", &port.to_string()])
        .env("TITLESEARCH_DESKTOP", "1")
        .env("TITLESEARCH_TOKEN", token)
        .envs(keychain_keys())
        .spawn()
        .map_err(|e| e.to_string())?;
    *app.state::<Sidecar>().child.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffer = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buffer.extend_from_slice(&bytes);
                    while let Some(end) = buffer.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=end).collect();
                        handle_line(&app, &line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    log::info!("sidecar: {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Terminated(status) => {
                    log::error!("The titlesearch sidecar stopped: {status:?}");
                    *app.state::<Sidecar>().child.lock().unwrap() = None;
                    show_failure(&app);
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn handle_line(app: &AppHandle, line: &[u8]) {
    let Ok(event) = serde_json::from_slice::<SidecarEvent>(line) else {
        return;
    };
    let state = app.state::<Sidecar>();
    match event {
        SidecarEvent::Ready { url, login_code } => {
            *state.url.lock().unwrap() = Some(url.clone());
            let hidden = std::env::args().any(|a| a == HIDDEN_ARG);
            if !hidden {
                open_window(app, &url, &login_code);
            }
        }
        SidecarEvent::Code { login_code } => {
            let open = std::mem::take(&mut *state.open_on_code.lock().unwrap());
            let url = state.url.lock().unwrap().clone();
            if let (true, Some(url)) = (open, url) {
                open_window(app, &url, &login_code);
            }
        }
        SidecarEvent::Token { token } => store_token(&token),
        SidecarEvent::Key { name, value } => store_key(&name, value.as_deref()),
    }
}

/// Shows the main window, creating it (with a fresh login code) if it's gone.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let state = app.state::<Sidecar>();
    *state.open_on_code.lock().unwrap() = true;
    // Any line on the sidecar's stdin asks it for a new login code.
    if let Some(child) = state.child.lock().unwrap().as_mut() {
        let _ = child.write(b"code\n");
    }
}

fn open_window(app: &AppHandle, url: &str, login_code: &str) {
    if app.get_webview_window(MAIN).is_some() {
        show_main(app);
        return;
    }
    let Ok(server) = Url::parse(url) else { return };
    // Login codes are Crockford base32; refuse anything else rather than escape it.
    if !login_code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return;
    }
    let script = format!(
        "window.__TITLESEARCH_DESKTOP_CODE__ = {};",
        serde_json::json!(login_code)
    );
    let origin = server.origin();
    let opener = app.clone();
    let opener_for_new = app.clone();
    let built = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(server))
        .title("Titlesearch")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(&script)
        // Only the local server loads in this window; links to other sites open in the browser.
        .on_navigation(move |target| {
            if target.origin() == origin {
                return true;
            }
            if matches!(target.scheme(), "http" | "https") {
                let _ = opener.opener().open_url(target.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window(move |target, _features| {
            if matches!(target.scheme(), "http" | "https") {
                let _ = opener_for_new
                    .opener()
                    .open_url(target.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build();
    match built {
        Ok(window) => {
            let hide = window.clone();
            window.on_window_event(move |event| {
                // Closing the window keeps Titlesearch running in the tray.
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hide.hide();
                }
            });
        }
        Err(e) => log::error!("Couldn't open the window: {e}"),
    }
}

/// Shown if the sidecar couldn't start or stopped.
fn show_failure(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.destroy();
    }
    let _ = WebviewWindowBuilder::new(app, "failure", WebviewUrl::App("index.html".into()))
        .title("Titlesearch")
        .inner_size(520.0, 360.0)
        .build();
}

/// Whether the updater has a real signing key configured. Until a release key
/// is set in tauri.conf.json, update checks are skipped.
fn updater_configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.starts_with("REPLACE_WITH"))
}

async fn check_for_update(app: AppHandle, install: bool, item: MenuItem<tauri::Wry>) {
    if !updater_configured(&app) {
        let _ = item.set_text("Updates aren't set up in this build");
        return;
    }
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("Updater unavailable: {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) if install => {
            let _ = item.set_text(format!("Installing {}…", update.version));
            // Signature-checked against the configured public key before installing.
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => app.restart(),
                Err(e) => {
                    log::error!("Update failed: {e}");
                    let _ = item.set_text("Update failed. Try again later");
                }
            }
        }
        Ok(Some(update)) => {
            let _ = item.set_text(format!("Install update {}…", update.version));
        }
        Ok(None) => {
            let _ = item.set_text("Titlesearch is up to date");
        }
        Err(e) => log::warn!("Update check failed: {e}"),
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Titlesearch", true, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(
        app,
        "login",
        "Start at login",
        true,
        autostart_on,
        None::<&str>,
    )?;
    let update = MenuItem::with_id(app, "update", "Check for updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Titlesearch", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &login, &update, &separator, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let update_item = update.clone();
    TrayIconBuilder::with_id("tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Titlesearch")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "login" => {
                let launcher = app.autolaunch();
                let enabled = launcher.is_enabled().unwrap_or(false);
                let result = if enabled {
                    launcher.disable()
                } else {
                    launcher.enable()
                };
                if let Err(e) = result {
                    log::error!("Couldn't change start at login: {e}");
                }
                let _ = login.set_checked(launcher.is_enabled().unwrap_or(false));
            }
            "update" => {
                tauri::async_runtime::spawn(check_for_update(
                    app.clone(),
                    true,
                    update_item.clone(),
                ));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    // A quiet check at startup: it only changes the menu item's text.
    tauri::async_runtime::spawn(check_for_update(app.clone(), false, update));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Sidecar::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            build_tray(app.handle())?;
            if let Err(e) = start_sidecar(app.handle()) {
                log::error!("Couldn't start the titlesearch sidecar: {e}");
                show_failure(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Titlesearch app");

    app.run(|app, event| match event {
        // The dock icon on macOS reopens the window.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        // Keep running in the tray when the last window closes.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(child) = app.state::<Sidecar>().child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
        _ => {}
    });
}
