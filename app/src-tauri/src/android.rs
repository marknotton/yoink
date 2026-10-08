use crate::ProbeResult;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    Manager, State, Wry,
};

pub struct YoinkHandle(PluginHandle<Wry>);

pub fn init() -> TauriPlugin<Wry> {
    Builder::<Wry>::new("yoink")
        .setup(|app, api| {
            let handle = api.register_android_plugin("io.github.marknotton.yoink", "YoinkPlugin")?;
            app.manage(YoinkHandle(handle));
            Ok(())
        })
        .build()
}

#[derive(Deserialize)]
struct PathResult {
    path: String,
}

// the Kotlin side rejects with a plain message — surface just that
fn msg(e: PluginInvokeError) -> String {
    match e {
        PluginInvokeError::InvokeRejected(r) => r.message.unwrap_or_else(|| "Something went wrong.".into()),
        other => other.to_string(),
    }
}

#[tauri::command]
pub async fn probe(h: State<'_, YoinkHandle>, url: String) -> Result<ProbeResult, String> {
    h.0.run_mobile_plugin_async("probe", json!({ "url": url })).await.map_err(msg)
}

#[tauri::command]
pub async fn download(
    h: State<'_, YoinkHandle>,
    job_id: String,
    url: String,
    info_path: Option<String>,
    choice_args: Vec<String>,
    // the folder is fixed on Android (Download/Yoink); the arg still has to be
    // named plainly, or Tauri would expect a `_outDir` key the UI never sends
    #[allow(unused_variables)] out_dir: String,
) -> Result<String, String> {
    let r: PathResult = h
        .0
        .run_mobile_plugin_async("download", json!({ "jobId": job_id, "url": url, "infoPath": info_path, "choiceArgs": choice_args }))
        .await
        .map_err(msg)?;
    Ok(r.path)
}

// Android has no event bridge from the plugin, so the UI polls this
#[tauri::command]
pub async fn download_progress(h: State<'_, YoinkHandle>, job_id: String) -> Result<Value, String> {
    h.0.run_mobile_plugin_async("progress", json!({ "jobId": job_id })).await.map_err(msg)
}

#[tauri::command]
pub async fn cancel_download(h: State<'_, YoinkHandle>, job_id: String) -> Result<(), String> {
    h.0.run_mobile_plugin_async::<Value>("cancelDownload", json!({ "jobId": job_id })).await.map(|_| ()).map_err(msg)
}

#[tauri::command]
pub async fn reveal(h: State<'_, YoinkHandle>, path: String) -> Result<(), String> {
    h.0.run_mobile_plugin_async::<Value>("reveal", json!({ "path": path })).await.map(|_| ()).map_err(msg)
}

#[tauri::command]
pub fn default_out_dir() -> String {
    "Download/Yoink".into()
}

#[tauri::command]
pub async fn open_url(h: State<'_, YoinkHandle>, url: String) -> Result<(), String> {
    h.0.run_mobile_plugin_async::<Value>("openUrl", json!({ "url": url })).await.map(|_| ()).map_err(msg)
}

#[tauri::command]
pub async fn open_downloads(h: State<'_, YoinkHandle>) -> Result<(), String> {
    h.0.run_mobile_plugin_async::<Value>("openDownloads", json!({})).await.map(|_| ()).map_err(msg)
}

// Android has no in-app updater, but it reads the same manifest
#[tauri::command]
pub fn platform_key() -> String {
    "android-arm64".into()
}
