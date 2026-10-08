use crate::ProbeResult;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const PROGRESS_PREFIX: &str = "YOINK|";

// ── State ───────────────────────────────────────────────────────
// Any number of downloads at once, keyed by the id the UI gives each one.
// The child sits behind a mutex so cancel can reach it while the download
// task is awaiting its output.
#[derive(Default)]
pub struct Slot {
    child: Option<CommandChild>,
    cancelled: bool,
}

#[derive(Default)]
pub struct Active {
    jobs: Mutex<HashMap<String, Slot>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: String,
    downloaded_bytes: f64,
    total_bytes: Option<f64>,
    speed: Option<f64>,
    eta: Option<f64>,
    part: u32,
    total_parts: u32,
}

// ── Helpers ─────────────────────────────────────────────────────
// Tauri copies sidecars next to the app executable (without the target
// triple), so ffmpeg is always at a known path inside the bundle.
fn ffmpeg_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.parent().ok_or("no exe dir")?.join("ffmpeg");
    if path.exists() {
        Ok(path)
    } else {
        Err("The bundled ffmpeg is missing from the app.".into())
    }
}

fn clean_error(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("ERROR:"))
        .last()
        .map(|l| {
            let rest = l.trim_start_matches("ERROR:").trim();
            // drop a leading "[extractor] " tag
            match (rest.starts_with('['), rest.find("] ")) {
                (true, Some(i)) => rest[i + 2..].to_string(),
                _ => rest.to_string(),
            }
        })
        .unwrap_or_default()
}

fn to_num(value: Option<&str>) -> Option<f64> {
    match value {
        Some("NA") | Some("None") | Some("") | None => None,
        Some(v) => v.parse::<f64>().ok().filter(|n| n.is_finite()),
    }
}

fn remove_partials(destinations: &[String]) {
    for dest in destinations {
        for file in [dest.clone(), format!("{dest}.part"), format!("{dest}.ytdl")] {
            let _ = fs::remove_file(Path::new(&file));
        }
    }
}

// SIGTERM, not SIGKILL: yt-dlp's onefile bootloader forwards SIGTERM to the
// real process, whereas killing the bootloader would orphan it.
// /bin/kill ships with macOS.
fn terminate(pid: u32) {
    let _ = Command::new("/bin/kill").args(["-TERM", &pid.to_string()]).status();
}

// ── Commands ────────────────────────────────────────────────────
#[tauri::command]
pub async fn probe(app: AppHandle, url: String) -> Result<ProbeResult, String> {
    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(["-J", "--no-playlist", "--no-warnings", &url])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let msg = clean_error(&String::from_utf8_lossy(&output.stderr));
        return Err(if msg.is_empty() {
            format!("yt-dlp exited with code {}", output.status.code().unwrap_or(-1))
        } else {
            msg
        });
    }

    let info = String::from_utf8_lossy(&output.stdout).to_string();
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let info_path = std::env::temp_dir().join(format!("yoink-info-{}-{stamp}.json", std::process::id()));
    fs::write(&info_path, &info).map_err(|e| e.to_string())?;
    Ok(ProbeResult { info, info_path: info_path.to_string_lossy().to_string() })
}

#[tauri::command]
pub async fn download(
    app: AppHandle,
    state: State<'_, Active>,
    job_id: String,
    url: String,
    info_path: Option<String>,
    choice_args: Vec<String>,
    out_dir: String,
) -> Result<String, String> {
    state.jobs.lock().unwrap().insert(job_id.clone(), Slot::default());
    let ffmpeg = ffmpeg_path()?;

    let mut args: Vec<String> = match &info_path {
        Some(p) => vec!["--load-info-json".into(), p.clone()],
        None => vec![url],
    };
    args.extend(choice_args);
    args.extend(
        [
            "--no-playlist",
            "--no-warnings",
            "--newline",
            // --print implies --quiet, which would hide the progress and
            // [Merger] / [ExtractAudio] lines we rely on
            "--no-quiet",
            "--progress",
            "--progress-template",
            "download:YOINK|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
            "--print",
            "after_move:filepath",
            "--no-simulate",
            "--ffmpeg-location",
        ]
        .map(String::from),
    );
    args.push(ffmpeg.to_string_lossy().to_string());
    args.push("-o".into());
    args.push(Path::new(&out_dir).join("%(title).60s.%(ext)s").to_string_lossy().to_string());

    let (mut rx, child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(&args)
        .spawn()
        .map_err(|e| e.to_string())?;
    match state.jobs.lock().unwrap().get_mut(&job_id) {
        Some(slot) => slot.child = Some(child),
        None => return Err("Download cancelled.".into()),
    }

    let mut filepath = String::new();
    let mut stderr = String::new();
    let mut exit_code: Option<i32> = None;
    let mut destinations: Vec<String> = Vec::new();
    let (mut part, mut total_parts, mut last_downloaded) = (0u32, 1u32, 0f64);

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                stderr.push_str(&String::from_utf8_lossy(&bytes));
                stderr.push('\n');
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if line.is_empty() {
                    continue;
                }
                if let Some(rest) = line.strip_prefix(PROGRESS_PREFIX) {
                    let mut f = rest.split('|');
                    let downloaded = to_num(f.next()).unwrap_or(0.0);
                    let total = to_num(f.next());
                    let estimate = to_num(f.next());
                    // bytes dropping back means yt-dlp moved on to the next stream
                    if downloaded < last_downloaded {
                        part += 1;
                    }
                    last_downloaded = downloaded;
                    let _ = app.emit(
                        "download-progress",
                        Progress {
                            job_id: job_id.clone(),
                            downloaded_bytes: downloaded,
                            total_bytes: total.or(estimate),
                            speed: to_num(f.next()),
                            eta: to_num(f.next()),
                            part,
                            total_parts,
                        },
                    );
                } else if line.contains("Downloading 1 format(s):") {
                    // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
                    let ids = line.split("format(s):").nth(1).unwrap_or("").trim();
                    total_parts = ids.split('+').count() as u32;
                } else if line.contains("[Merger]") || line.contains("[ExtractAudio]") {
                    if let Some(t) = line
                        .strip_prefix("[Merger] Merging formats into \"")
                        .and_then(|r| r.strip_suffix('"'))
                        .or_else(|| line.strip_prefix("[ExtractAudio] Destination: "))
                    {
                        destinations.push(t.to_string());
                    }
                    let _ = app.emit("download-processing", job_id.clone());
                } else if let Some(dest) = line.strip_prefix("[download] Destination: ") {
                    destinations.push(dest.to_string());
                } else if Path::new(&line).is_absolute() {
                    filepath = line;
                }
            }
            _ => {}
        }
    }
    let cancelled = state.jobs.lock().unwrap().remove(&job_id).map(|s| s.cancelled).unwrap_or(true);

    if cancelled {
        remove_partials(&destinations);
        return Err("Download cancelled.".into());
    }
    if exit_code == Some(0) && !filepath.is_empty() {
        return Ok(filepath);
    }
    let msg = clean_error(&stderr);
    Err(if msg.is_empty() {
        format!("Download failed (yt-dlp exit code {}).", exit_code.unwrap_or(-1))
    } else {
        msg
    })
}

#[tauri::command]
pub fn cancel_download(state: State<'_, Active>, job_id: String) {
    if let Some(slot) = state.jobs.lock().unwrap().get_mut(&job_id) {
        slot.cancelled = true;
        if let Some(child) = slot.child.as_ref() {
            terminate(child.pid());
        }
    }
}

#[tauri::command]
pub fn reveal(path: String) {
    let _ = Command::new("open").args(["-R", &path]).spawn();
}

// only the credits link — never an arbitrary URL from the page
#[tauri::command]
pub fn open_url(url: String) {
    if url.starts_with("https://github.com/") {
        let _ = Command::new("open").arg(url).spawn();
    }
}

// whether a file we saved earlier is still there
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

// open a saved file in its default app. Only media types, so this can't launch an app or script.
#[tauri::command]
pub fn open_file(path: String) {
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if Path::new(&path).is_file() && ["mp4", "mp3", "m4a", "webm", "mkv", "mov"].contains(&ext.as_str()) {
        let _ = Command::new("open").arg(path).spawn();
    }
}

// the manifest key for this machine, e.g. "darwin-aarch64"
#[tauri::command]
pub fn platform_key() -> String {
    format!("darwin-{}", std::env::consts::ARCH)
}

#[tauri::command]
pub fn default_out_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join("Downloads").to_string_lossy().to_string()
}

