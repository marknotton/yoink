use serde::{Deserialize, Serialize};

// Desktop runs yt-dlp/ffmpeg as bundled sidecars; Android hands the same
// commands to a Kotlin plugin (youtubedl-android). The frontend can't tell.
#[cfg(desktop)]
mod desktop;
#[cfg(target_os = "android")]
mod android;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub info: String,
    pub info_path: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    #[cfg(desktop)]
    let builder = builder
        .manage(desktop::Active::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        // in-app updates are desktop-only; Android is offered a download instead
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            desktop::probe,
            desktop::download,
            desktop::cancel_download,
            desktop::reveal,
            desktop::default_out_dir,
            desktop::open_url,
            desktop::platform_key
        ]);

    #[cfg(target_os = "android")]
    let builder = builder.plugin(android::init()).invoke_handler(tauri::generate_handler![
        android::probe,
        android::download,
        android::download_progress,
        android::cancel_download,
        android::reveal,
        android::default_out_dir,
        android::open_url,
        android::open_downloads,
        android::platform_key
    ]);

    builder.run(tauri::generate_context!()).expect("error while running Yoink");
}
