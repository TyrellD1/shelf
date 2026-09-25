//! Shelf desktop — a thin, local-first shell around the `shelf` CLI.
//!
//! Everything data-shaped is delegated to the CLI (`shelf status|list|read|sync`),
//! so the app never disagrees with the terminal about what is on the shelf.
//! Artifacts are served to the reader iframe through the `shelf://` scheme with a
//! strict CSP, so a document can never reach the network from the desktop app.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::{DeepLinkExt, OpenUrlEvent};

/// Content of an artifact: inline scripts and styles only, no network of any kind.
const DOCUMENT_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

#[derive(Default)]
struct OpenState {
    /// A `shelf open` that arrived before the webview was listening.
    pending: Mutex<Option<serde_json::Value>>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .manage(OpenState::default())
        .invoke_handler(tauri::generate_handler![
            shelf_run,
            shelf_sync,
            shelf_setup,
            shelf_cli_info,
            shelf_pending_open,
        ])
        .register_uri_scheme_protocol("shelf", |_app, request| {
            let uri = request.uri().to_string();
            let theme = request
                .uri()
                .query()
                .and_then(|query| query_param(query, "theme"))
                .filter(|value| value == "light" || value == "dark");
            let id = uri
                .split("/view/")
                .nth(1)
                .unwrap_or_default()
                .split(['?', '#'])
                .next()
                .unwrap_or_default();
            if id.is_empty() {
                return plain(404, "shelf: missing document id");
            }
            match document(id, theme.as_deref()) {
                Ok(html) => {
                    eprintln!("shelf: served {} ({} bytes, {:?})", id, html.len(), theme);
                    http_response(200, DOCUMENT_CSP, html.into_bytes())
                }
                Err(error) => {
                    eprintln!("shelf: could not serve {id}: {error}");
                    plain(404, &format!("shelf: {error}"))
                }
            }
        })
        .setup(|app| {
            size_window(app.handle());
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event: OpenUrlEvent| {
                for url in event.urls() {
                    if let Some(payload) = open_payload(&url.to_string()) {
                        announce(&handle, payload);
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running shelf");
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/// Runs any CLI command and returns its JSON output (`--json` is appended).
#[tauri::command]
async fn shelf_run(args: Vec<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut full = args;
        if !full.iter().any(|arg| arg == "--json") {
            full.push("--json".into());
        }
        let output = run_cli(&full)?;
        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stdout.is_empty() { stderr } else { stdout });
        }
        serde_json::from_slice(&output.stdout).map_err(|error| format!("shelf returned bad JSON: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Runs `shelf sync --json --stream`, forwarding progress lines as events.
#[tauri::command]
async fn shelf_sync(app: AppHandle, on_progress: bool) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let binary = resolve_cli()?;
        let mut child = Command::new(binary)
            .args(["sync", "--json", "--stream"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not start the shelf CLI: {error}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "shelf sync produced no output".to_string())?;

        let mut result: Option<serde_json::Value> = None;
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            match value.get("type").and_then(|kind| kind.as_str()) {
                Some("progress") => {
                    if on_progress {
                        let message = value
                            .get("message")
                            .and_then(|message| message.as_str())
                            .unwrap_or("syncing")
                            .to_string();
                        let _ = app.emit("shelf-progress", message);
                    }
                }
                Some("result") => result = Some(value),
                _ => {}
            }
        }

        let status = child
            .wait()
            .map_err(|error| format!("shelf sync did not finish: {error}"))?;
        if !status.success() {
            return Err("shelf sync failed. Run `shelf sync` in a terminal for details.".into());
        }
        result.ok_or_else(|| "shelf sync returned no result".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `shelf setup`: opens the browser, waits for the loopback handoff.
#[tauri::command]
async fn shelf_setup() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_cli(&["setup".into()])?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if !output.status.success() {
            return Err(if stdout.trim().is_empty() { stderr } else { stdout });
        }
        Ok(format!("{stdout}{stderr}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CliInfo {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn shelf_cli_info() -> CliInfo {
    tauri::async_runtime::spawn_blocking(move || match resolve_cli() {
        Ok(path) => {
            let version = run_cli(&["version".into()])
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|text| text.trim().to_string());
            CliInfo {
                found: true,
                path: Some(path.display().to_string()),
                version,
                error: None,
            }
        }
        Err(error) => CliInfo {
            found: false,
            path: None,
            version: None,
            error: Some(error),
        },
    })
    .await
    .unwrap_or_else(|error| CliInfo {
        found: false,
        path: None,
        version: None,
        error: Some(error.to_string()),
    })
}

#[tauri::command]
fn shelf_pending_open(state: State<'_, OpenState>) -> Option<serde_json::Value> {
    state.pending.lock().ok().and_then(|mut slot| slot.take())
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn announce(app: &AppHandle, payload: serde_json::Value) {
    eprintln!("shelf: deep link {payload}");
    if let Ok(mut slot) = app.state::<OpenState>().pending.lock() {
        *slot = Some(payload.clone());
    }
    let _ = app.emit("shelf:open", payload);
}

/// Opens at a comfortable size for the display it lands on, centred.
fn size_window(app: &AppHandle) {
    const PREFERRED_WIDTH: f64 = 1708.0;
    const PREFERRED_HEIGHT: f64 = 940.0;
    const MARGIN: f64 = 40.0;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let monitor = window.current_monitor().ok().flatten().or_else(|| {
        window.primary_monitor().ok().flatten()
    });
    let Some(monitor) = monitor else {
        return;
    };

    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let width = (work.size.width as f64 / scale - MARGIN).min(PREFERRED_WIDTH);
    let height = (work.size.height as f64 / scale - MARGIN).min(PREFERRED_HEIGHT);

    let before = window.inner_size().map(|s| (s.width, s.height));
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    let _ = window.center();
    eprintln!(
        "shelf: theme {:?}, scale {scale}, work {}x{} physical, target {width}x{height} logical, inner before {before:?}, inner after {:?}, outer {:?}",
        window.theme(),
        work.size.width,
        work.size.height,
        window.inner_size().map(|s| (s.width, s.height)),
        window.outer_size().map(|s| (s.width, s.height)),
    );
}

fn run_cli(args: &[String]) -> Result<Output, String> {
    let binary = resolve_cli()?;
    Command::new(&binary)
        .args(args)
        .env("SHELF_NONINTERACTIVE", "1")
        .output()
        .map_err(|error| format!("could not run {}: {error}", binary.display()))
}

/// Same bytes the reader would get from `shelf read <id>`, themed for the app.
fn document(id: &str, theme: Option<&str>) -> Result<String, String> {
    let output = run_cli(&["read".into(), id.into()])?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stdout.is_empty() { stderr } else { stdout };
        return Err(if message.is_empty() {
            format!("could not read {id}")
        } else {
            message
        });
    }
    let html = String::from_utf8(output.stdout).map_err(|_| "document is not valid UTF-8".to_string())?;
    Ok(inject_theme(&html, theme))
}

/// Artifacts from the `/html` and `/slides` skills store their theme under the
/// `html-theme` key and read it in a blocking script in `<head>`. Setting that
/// key first, then correcting the attribute once their script has run, makes an
/// artifact open in whatever theme the app is showing — without touching how the
/// artifact was written.
fn inject_theme(html: &str, theme: Option<&str>) -> String {
    let Some(theme) = theme.filter(|value| *value == "light" || *value == "dark") else {
        return html.to_string();
    };
    let script = format!("<script>{}</script>", theme_bootstrap(theme));
    match html.find("<head") {
        Some(start) => {
            let insert_at = html[start..]
                .find('>')
                .map(|offset| start + offset + 1)
                .unwrap_or(start);
            let mut out = String::with_capacity(html.len() + script.len());
            out.push_str(&html[..insert_at]);
            out.push_str(&script);
            out.push_str(&html[insert_at..]);
            out
        }
        None => format!("{script}{html}"),
    }
}

fn theme_bootstrap(theme: &str) -> String {
    format!(
        r#"(function(){{var theme="{theme}";var root=document.documentElement;function apply(){{try{{root.dataset.themePreference=theme;root.dataset.theme=theme}}catch(e){{}}}}try{{localStorage.setItem("html-theme",theme)}}catch(e){{}}apply();document.addEventListener("DOMContentLoaded",apply);addEventListener("message",function(event){{var next=event&&event.data&&event.data.shelfTheme;if(next!=="light"&&next!=="dark")return;theme=next;try{{localStorage.setItem("html-theme",next)}}catch(e){{}}apply()}});}})();"#
    )
}

/// Reads one query parameter, percent-decoded.
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        if parts.next() == Some(key) {
            return parts.next().map(percent_decode);
        }
    }
    None
}

fn http_response(status: u16, csp: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("content-security-policy", csp)
        .header("cache-control", "no-store")
        .body(body)
        .expect("valid response")
}

fn plain(status: u16, message: &str) -> tauri::http::Response<Vec<u8>> {
    http_response(status, "default-src 'none'", message.as_bytes().to_vec())
}

/// Finds the `shelf` binary: `SHELF_BIN`, then the usual install locations, then PATH.
fn resolve_cli() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("SHELF_BIN") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!("SHELF_BIN points at a missing file: {}", path.display()));
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.local/bin/shelf"),
        format!("{home}/bin/shelf"),
        "/opt/homebrew/bin/shelf".to_string(),
        "/usr/local/bin/shelf".to_string(),
    ];
    for candidate in candidates {
        let path = PathBuf::from(&candidate);
        if path.is_file() {
            return Ok(path);
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("shelf");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err("shelf CLI not found. Install it (see the repo README) or set SHELF_BIN.".into())
}

/// `shelf://open?id=sf_x` / `shelf://open?path=notes/a.html`
fn open_payload(url: &str) -> Option<serde_json::Value> {
    let query = url.split_once('?')?.1;
    let mut id: Option<String> = None;
    let mut path: Option<String> = None;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        match (parts.next(), parts.next()) {
            (Some("id"), Some(value)) if !value.is_empty() => id = Some(percent_decode(value)),
            (Some("path"), Some(value)) if !value.is_empty() => path = Some(percent_decode(value)),
            _ => {}
        }
    }
    if id.is_none() && path.is_none() {
        return None;
    }
    let mut payload = serde_json::Map::new();
    if let Some(id) = id {
        payload.insert("id".into(), serde_json::Value::String(id));
    }
    if let Some(path) = path {
        payload.insert("path".into(), serde_json::Value::String(path));
    }
    Some(serde_json::Value::Object(payload))
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_deep_links() {
        let payload = open_payload("shelf://open?id=sf_abc123").expect("id payload");
        assert_eq!(payload["id"], "sf_abc123");

        let payload = open_payload("shelf://open?path=notes%2Freport.html").expect("path payload");
        assert_eq!(payload["path"], "notes/report.html");

        assert!(open_payload("shelf://open").is_none());
        assert!(open_payload("shelf://open?other=1").is_none());
    }

    #[test]
    fn reader_content_comes_from_the_cli() {
        let dir = std::env::temp_dir().join(format!("shelf-reader-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let binary = dir.join("shelf");
        std::fs::write(
            &binary,
            "#!/bin/sh\nif [ \"$1\" = \"read\" ] && [ -n \"$2\" ]; then printf '<h1>%s</h1>' \"$2\"; exit 0; fi\necho 'shelf: not found' >&2\nexit 1\n",
        )
        .expect("stub cli");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&binary).expect("metadata").permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&binary, permissions).expect("chmod");
        }

        std::env::set_var("SHELF_BIN", &binary);
        assert_eq!(document("sf_test", None).expect("document"), "<h1>sf_test</h1>");
        assert!(document("", None).is_err());
        std::env::remove_var("SHELF_BIN");
    }

    #[test]
    fn themes_are_injected_ahead_of_the_artifact() {
        let html = "<html><head><meta charset=\"utf-8\"><script>var t=localStorage.getItem('html-theme')</script></head><body></body></html>";
        let themed = inject_theme(html, Some("dark"));
        let injected = themed.find("localStorage.setItem").expect("bootstrap injected");
        let artifact = themed.find("var t=localStorage").expect("artifact script present");
        assert!(injected < artifact, "bootstrap must run before the artifact reads the key");
        assert!(themed.starts_with("<html><head><script>"));
        assert!(themed.contains("<meta charset=\"utf-8\">"));
        assert!(themed.contains("shelfTheme"));
        assert!(themed.len() > html.len());

        // No theme (or a nonsense one) leaves the document untouched.
        assert_eq!(inject_theme(html, None), html);
        assert_eq!(inject_theme(html, Some("system")), html);

        // Headless fragments still get the bootstrap.
        let fragment = inject_theme("<p>hi</p>", Some("light"));
        assert!(fragment.starts_with("<script>"));
        assert!(fragment.ends_with("<p>hi</p>"));
    }

    #[test]
    fn reads_the_theme_from_the_query() {
        assert_eq!(query_param("theme=dark&x=1", "theme"), Some("dark".into()));
        assert_eq!(query_param("x=1&theme=light", "theme"), Some("light".into()));
        assert_eq!(query_param("x=1", "theme"), None);
    }
}
