// Desktop sign-in: a throwaway browser window where the user logs in to a site, after which
// the session cookies are read from it and saved for yt-dlp. Yoink never sees the password.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

// one number per yt-dlp run, so concurrent runs never share a temp file
static COUNTER: AtomicU64 = AtomicU64::new(0);

const WINDOW: &str = "signin";
const HEADER: &str = "# Netscape HTTP Cookie File";

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn cookies_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("cookies.txt"))
}

/// A private copy for one yt-dlp run. yt-dlp rewrites the cookie file when it exits, so several
/// runs sharing one file could corrupt it; each gets its own and it's deleted afterwards.
pub struct TempCookies(pub Option<PathBuf>);

impl TempCookies {
    pub fn for_run(app: &AppHandle, wanted: bool) -> Self {
        if !wanted {
            return Self(None);
        }
        let Ok(master) = cookies_file(app) else { return Self(None) };
        if !master.is_file() {
            return Self(None);
        }
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let tmp = std::env::temp_dir().join(format!("yoink-cookies-{}-{n}.txt", std::process::id()));
        match fs::copy(&master, &tmp) {
            Ok(_) => Self(Some(tmp)),
            Err(_) => Self(None),
        }
    }
    pub fn args(&self) -> Vec<String> {
        self.0.as_ref().map(|p| vec!["--cookies".to_string(), p.to_string_lossy().to_string()]).unwrap_or_default()
    }
}

impl Drop for TempCookies {
    fn drop(&mut self) {
        if let Some(p) = &self.0 {
            let _ = fs::remove_file(p);
        }
    }
}

fn domain_of(line: &str) -> String {
    let first = line.split('\t').next().unwrap_or("");
    first.trim_start_matches("#HttpOnly_").trim_start_matches('.').to_lowercase()
}

fn matches_any(domain: &str, targets: &[String]) -> bool {
    targets.iter().any(|t| domain == t || domain.ends_with(&format!(".{t}")) || t.ends_with(&format!(".{domain}")))
}

fn read_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .map(|s| s.lines().filter(|l| !l.is_empty() && !l.starts_with('#') || l.starts_with("#HttpOnly_")).map(String::from).collect())
        .unwrap_or_default()
}

fn write_lines(path: &Path, lines: &[String]) -> Result<(), String> {
    let body = format!("{HEADER}\n{}\n", lines.join("\n"));
    fs::write(path, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600)); // a login: private to this user
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigninStatus {
    open: bool,
    signed_in: bool,
    done: bool,
}

fn parse_urls(urls: &[String]) -> Vec<Url> {
    urls.iter().filter_map(|u| u.parse::<Url>().ok()).collect()
}

#[tauri::command]
pub async fn signin_open(app: AppHandle, url: String, title: String) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|_| "That isn't a valid link.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Sign-in pages must be https.".into());
    }
    if let Some(existing) = app.get_webview_window(WINDOW) {
        let _ = existing.destroy();
        // the label can't be reused until the old window is really gone
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(400))).await.ok();
    }
    WebviewWindowBuilder::new(&app, WINDOW, WebviewUrl::External(parsed))
        .title(title)
        .inner_size(480.0, 740.0)
        .center()
        // nothing from this window lingers once we've taken the session we need
        .incognito(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn signin_status(app: AppHandle, urls: Vec<String>, markers: Vec<String>) -> SigninStatus {
    let Some(window) = app.get_webview_window(WINDOW) else {
        return SigninStatus { open: false, signed_in: false, done: false };
    };
    let signed_in = !markers.is_empty()
        && parse_urls(&urls).into_iter().any(|u| {
            window.cookies_for_url(u).map(|cs| cs.iter().any(|c| markers.iter().any(|m| c.name() == m))).unwrap_or(false)
        });
    SigninStatus { open: true, signed_in, done: false }
}

/// Take the cookies out of the sign-in window, merge them into the saved file, close the window.
#[tauri::command]
pub async fn signin_finish(app: AppHandle, urls: Vec<String>, markers: Vec<String>, force: Option<bool>) -> Result<usize, String> {
    let window = app.get_webview_window(WINDOW).ok_or("The sign-in window was closed.")?;
    let mut fresh: Vec<String> = Vec::new();
    let mut domains: Vec<String> = Vec::new();
    for url in parse_urls(&urls) {
        let host = url.host_str().unwrap_or("").to_string();
        for c in window.cookies_for_url(url).map_err(|e| e.to_string())? {
            let domain = c.domain().map(String::from).unwrap_or_else(|| host.clone());
            let bare = domain.trim_start_matches('.').to_lowercase();
            let expiry = c.expires_datetime().map(|d| d.unix_timestamp()).unwrap_or(now() + 365 * 24 * 3600); // session cookies: a year
            let flag = |b: bool| if b { "TRUE" } else { "FALSE" };
            let prefix = if c.http_only() == Some(true) { "#HttpOnly_" } else { "" };
            fresh.push(format!(
                "{prefix}{domain}\t{}\t{}\t{}\t{expiry}\t{}\t{}",
                flag(domain.starts_with('.')),
                c.path().unwrap_or("/"),
                flag(c.secure() == Some(true)),
                c.name(),
                c.value()
            ));
            if !domains.contains(&bare) {
                domains.push(bare);
            }
        }
    }
    if fresh.is_empty() {
        return Err("NOT_SIGNED_IN|".into());
    }
    // A logged-out visitor already has cookies, so "some cookies" proves nothing. Where we know
    // what a login looks like, insist on it, and say which cookies we did see (names only).
    if !force.unwrap_or(false) && !markers.is_empty() {
        let names: Vec<String> = fresh.iter().filter_map(|l| l.split('\t').nth(5).map(String::from)).collect();
        if !names.iter().any(|n| markers.contains(n)) {
            return Err(format!("NOT_SIGNED_IN|{}", names.join(", ")));
        }
    }
    let path = cookies_file(&app)?;
    let mut lines: Vec<String> = read_lines(&path).into_iter().filter(|l| !matches_any(&domain_of(l), &domains)).collect();
    let count = fresh.len();
    lines.extend(fresh);
    write_lines(&path, &lines)?;
    let _ = window.destroy();
    Ok(count)
}

#[tauri::command]
pub async fn signin_cancel(app: AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.destroy();
    }
}

/// Sign out: drop the saved cookies for these domains.
#[tauri::command]
pub async fn cookies_forget(app: AppHandle, domains: Vec<String>) -> Result<(), String> {
    let path = cookies_file(&app)?;
    let targets: Vec<String> = domains.iter().map(|d| d.trim_start_matches('.').to_lowercase()).collect();
    let kept: Vec<String> = read_lines(&path).into_iter().filter(|l| !matches_any(&domain_of(l), &targets)).collect();
    write_lines(&path, &kept)
}
