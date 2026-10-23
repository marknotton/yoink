// Desktop sign-in: a throwaway browser window where the user logs in to a site, after which
// the session cookies are read from it and saved for yt-dlp. Yoink never sees the password.
use base64::Engine;
use serde::{Deserialize, Serialize};
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

/// What proves a login. A cookie name alone isn't enough where logged-out visitors get the same
/// cookie, so a rule can also reject a token whose own claims say it belongs to an anonymous subject.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerRule {
    name: String,
    jwt_sub_not: Option<Vec<String>>,
}

// the "sub" claim of a JWT, read locally; the token never leaves this machine
fn jwt_sub(value: &str) -> Option<String> {
    let payload = value.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("sub")?.as_str().map(String::from)
}

fn proves_login(rule: &MarkerRule, name: &str, value: &str) -> bool {
    if rule.name != name {
        return false;
    }
    match &rule.jwt_sub_not {
        None => true,
        Some(anonymous) => jwt_sub(value).map(|sub| !anonymous.contains(&sub)).unwrap_or(false),
    }
}

/// Describe a cookie for the "here's what I saw" message: its name, flagged if it's a logged-out token.
fn describe(rules: &[MarkerRule], name: &str, value: &str) -> String {
    let logged_out = rules.iter().any(|r| r.name == name && r.jwt_sub_not.as_ref().is_some_and(|bad| jwt_sub(value).is_some_and(|s| bad.contains(&s))));
    if logged_out { format!("{name} [logged-out]") } else { name.to_string() }
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
pub async fn signin_status(app: AppHandle, urls: Vec<String>, markers: Vec<MarkerRule>) -> SigninStatus {
    let Some(window) = app.get_webview_window(WINDOW) else {
        return SigninStatus { open: false, signed_in: false, done: false };
    };
    let signed_in = !markers.is_empty()
        && parse_urls(&urls).into_iter().any(|u| {
            window.cookies_for_url(u).map(|cs| cs.iter().any(|c| markers.iter().any(|m| proves_login(m, c.name(), c.value())))).unwrap_or(false)
        });
    SigninStatus { open: true, signed_in, done: false }
}

/// Take the cookies out of the sign-in window, merge them into the saved file, close the window.
#[tauri::command]
pub async fn signin_finish(app: AppHandle, urls: Vec<String>, markers: Vec<MarkerRule>, force: Option<bool>) -> Result<usize, String> {
    let window = app.get_webview_window(WINDOW).ok_or("The sign-in window was closed.")?;
    let mut fresh: Vec<String> = Vec::new();
    let mut seen: Vec<(String, String)> = Vec::new(); // (name, value), for the login check only
    let mut domains: Vec<String> = Vec::new();
    for url in parse_urls(&urls) {
        let host = url.host_str().unwrap_or("").to_string();
        for c in window.cookies_for_url(url).map_err(|e| e.to_string())? {
            seen.push((c.name().to_string(), c.value().to_string()));
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
    // where the sign-in window is pointed (host and path only), to tell "still on the login page" from "logged in"
    let where_now = window.url().map(|u| format!("{}{}", u.host_str().unwrap_or(""), u.path())).unwrap_or_default();
    if fresh.is_empty() {
        return Err(format!("NOT_SIGNED_IN||{where_now}"));
    }
    // A logged-out visitor already has cookies, so "some cookies" proves nothing. Where we know
    // what a login looks like, insist on it, and say which cookies we did see (names only).
    if !force.unwrap_or(false) && !markers.is_empty() {
        if !seen.iter().any(|(n, v)| markers.iter().any(|m| proves_login(m, n, v))) {
            let names: Vec<String> = seen.iter().map(|(n, v)| describe(&markers, n, v)).collect();
            return Err(format!("NOT_SIGNED_IN|{}|{where_now}", names.join(", ")));
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

/// Point the sign-in window at a link, e.g. a "log me in" link from an email, so it signs in here
/// and not in the user's regular browser. Only the site's own domains are accepted.
#[tauri::command]
pub async fn signin_navigate(app: AppHandle, url: String, domains: Vec<String>) -> Result<(), String> {
    let parsed: Url = url.trim().parse().map_err(|_| "That isn't a valid link.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only https links can be opened here.".into());
    }
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    if !domains.iter().any(|d| host == *d || host.ends_with(&format!(".{d}"))) {
        return Err(format!("That link isn't from {}.", domains.join(" or ")));
    }
    let window = app.get_webview_window(WINDOW).ok_or("The sign-in window was closed.")?;
    window.navigate(parsed).map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    // header.payload.signature, payload = base64url(json)
    fn token(json: &str) -> String {
        let enc = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        format!("{}.{}.sig", enc(r#"{"alg":"RS256","typ":"JWT"}"#), enc(json))
    }

    fn reddit_rules() -> Vec<MarkerRule> {
        vec![
            MarkerRule { name: "reddit_session".into(), jwt_sub_not: None },
            MarkerRule { name: "token_v2".into(), jwt_sub_not: Some(vec!["loid".into()]) },
        ]
    }

    #[test]
    fn a_logged_out_token_does_not_prove_a_login() {
        let anonymous = token(r#"{"sub":"loid","lid":"t2_abc","cid":"x"}"#);
        assert!(!proves_login(&reddit_rules()[1], "token_v2", &anonymous));
        assert!(describe(&reddit_rules(), "token_v2", &anonymous).ends_with("[logged-out]"));
    }

    #[test]
    fn a_token_belonging_to_a_user_proves_a_login() {
        let user = token(r#"{"sub":"t2_1a2b3c","lid":"t2_abc"}"#);
        assert!(proves_login(&reddit_rules()[1], "token_v2", &user));
        assert_eq!(describe(&reddit_rules(), "token_v2", &user), "token_v2");
    }

    #[test]
    fn a_plain_login_cookie_is_enough_by_name() {
        assert!(proves_login(&reddit_rules()[0], "reddit_session", "anything"));
        assert!(!proves_login(&reddit_rules()[0], "csrf_token", "anything"));
    }

    #[test]
    fn something_that_is_not_a_token_never_counts() {
        assert!(!proves_login(&reddit_rules()[1], "token_v2", "not-a-jwt"));
        assert!(!proves_login(&reddit_rules()[1], "token_v2", ""));
    }
}
