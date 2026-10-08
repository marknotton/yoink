package io.github.marknotton.yoink

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.pm.PackageManager
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

@InvokeArg
class ProbeArgs {
    lateinit var url: String
}

@InvokeArg
class JobArgs {
    lateinit var jobId: String
}

@InvokeArg
class DownloadArgs {
    lateinit var jobId: String
    lateinit var url: String
    var infoPath: String? = null
    var choiceArgs: List<String> = emptyList()
}

@InvokeArg
class UrlArgs {
    lateinit var url: String
}

@InvokeArg
class RevealArgs {
    lateinit var path: String
}

// ── yt-dlp on Android ────────────────────────────────────────────
// Mirrors the desktop commands (probe / download / cancel / reveal). Tauri
// has no event bridge for this plugin, so progress sits in fields the UI
// polls through the `progress` command.
@TauriPlugin
class YoinkPlugin(private val activity: Activity) : Plugin(activity) {
    private val ready = CountDownLatch(1)
    @Volatile private var initError: String? = null

    // one of these per running download, so several can go at once
    private class Job {
        @Volatile var cancelled = false
        @Volatile var active = true
        @Volatile var percent = 0.0
        @Volatile var speed: Double? = null
        @Volatile var eta: Long? = null
        @Volatile var part = 0
        @Volatile var totalParts = 1
        @Volatile var processing = false
    }

    private val jobs = ConcurrentHashMap<String, Job>()

    private val savedUris = HashMap<String, Uri>()

    override fun load(webView: WebView) {
        thread {
            try {
                YoutubeDL.getInstance().init(activity.application)
                FFmpeg.getInstance().init(activity.application)
            } catch (e: Exception) {
                initError = e.message ?: "Could not start yt-dlp."
            }
            ready.countDown()
            // sites change constantly — freshen yt-dlp in the background, best effort
            try {
                YoutubeDL.getInstance().updateYoutubeDL(activity.application, YoutubeDL.UpdateChannel.STABLE)
            } catch (_: Exception) {
            }
        }
    }

    private fun awaitReady() {
        ready.await()
        initError?.let { throw IllegalStateException(it) }
    }

    // YoutubeDLException messages carry yt-dlp's stderr — keep the last ERROR line
    private fun clean(message: String?): String {
        val line = message?.lines()?.map { it.trim() }?.lastOrNull { it.startsWith("ERROR:") }
        return line?.removePrefix("ERROR:")?.trim()?.replace(Regex("^\\[[^\\]]+\\]\\s*"), "")
            ?: message?.take(300)
            ?: "Something went wrong."
    }

    @Command
    fun probe(invoke: Invoke) {
        val args = invoke.parseArgs(ProbeArgs::class.java)
        thread {
            try {
                awaitReady()
                val request = YoutubeDLRequest(args.url)
                request.addOption("-J")
                request.addOption("--no-playlist")
                request.addOption("--no-warnings")
                val info = YoutubeDL.getInstance().execute(request).out
                val file = File(activity.cacheDir, "yoink-info-${System.currentTimeMillis()}.json")
                file.writeText(info)
                invoke.resolve(JSObject().put("info", info).put("infoPath", file.absolutePath))
            } catch (e: Exception) {
                invoke.reject(clean(e.message))
            }
        }
    }

    @Command
    fun download(invoke: Invoke) {
        val args = invoke.parseArgs(DownloadArgs::class.java)
        val job = Job()
        jobs[args.jobId] = job
        askForNotifications()
        thread {
            val workDir = File(activity.cacheDir, "yoink-dl/${args.jobId}")
            try {
                awaitReady()
                workDir.deleteRecursively()
                workDir.mkdirs()

                val request = if (args.infoPath != null) YoutubeDLRequest(emptyList()) else YoutubeDLRequest(args.url)
                args.infoPath?.let { request.addOption("--load-info-json", it) }
                // choice args are flag/value pairs: ["-f", "bv*…", "--merge-output-format", "mp4"]
                var i = 0
                while (i < args.choiceArgs.size) {
                    val flag = args.choiceArgs[i]
                    val next = args.choiceArgs.getOrNull(i + 1)
                    if (next != null && !next.startsWith("-")) {
                        request.addOption(flag, next); i += 2
                    } else {
                        request.addOption(flag); i += 1
                    }
                }
                request.addOption("--no-playlist")
                request.addOption("--no-warnings")
                request.addOption("--newline")
                request.addOption("--no-quiet")
                request.addOption("--print", "after_move:filepath")
                request.addOption("--no-simulate")
                request.addOption("-o", File(workDir, "%(title).60s.%(ext)s").absolutePath)

                var filepath = ""
                var lastPercent = 0.0
                YoutubeDL.getInstance().execute(request, args.jobId) { _, etaSeconds, line ->
                    Regex("""\[download]\s+([\d.]+)%""").find(line)?.let {
                        val p = it.groupValues[1].toDouble()
                        if (p < lastPercent) job.part++ // percent restarting = next stream (video, then audio)
                        lastPercent = p
                        job.percent = p
                        job.processing = false
                        job.speed = Regex("""at\s+([\d.]+)(\w+)/s""").find(line)?.let { m -> toBytes(m.groupValues[1], m.groupValues[2]) }
                        job.eta = if (etaSeconds >= 0) etaSeconds else null
                    }
                    when {
                        line.contains("format(s):") ->
                            job.totalParts = line.substringAfter("format(s):").trim().split("+").size
                        line.contains("[Merger]") || line.contains("[ExtractAudio]") -> job.processing = true
                        line.startsWith("/") -> filepath = line.trim()
                    }
                }

                if (filepath.isEmpty() || !File(filepath).exists()) {
                    throw IllegalStateException("Download finished but no file was produced.")
                }
                val saved = saveToDownloads(File(filepath))
                notifyDone(saved)
                invoke.resolve(JSObject().put("path", saved))
            } catch (e: Exception) {
                invoke.reject(if (job.cancelled) "Download cancelled." else clean(e.message))
            } finally {
                job.active = false
                workDir.deleteRecursively()
            }
        }
    }

    private fun toBytes(value: String, unit: String): Double? {
        val n = value.toDoubleOrNull() ?: return null
        val mult = when (unit.lowercase()) {
            "b" -> 1.0
            "kib" -> 1024.0
            "mib" -> 1024.0 * 1024
            "gib" -> 1024.0 * 1024 * 1024
            else -> return null
        }
        return n * mult
    }

    // Scoped storage: no permission needed to add to Download/ via MediaStore
    private fun saveToDownloads(file: File): String {
        val display = "Download/Yoink/${file.name}"
        val mime = when (file.extension.lowercase()) {
            "mp4" -> "video/mp4"
            "mp3" -> "audio/mpeg"
            "webm" -> "video/webm"
            "m4a" -> "audio/mp4"
            else -> "application/octet-stream"
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = activity.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, file.name)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, "Download/Yoink")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("Could not create the file in Downloads.")
            resolver.openOutputStream(uri)!!.use { out -> file.inputStream().use { it.copyTo(out) } }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            savedUris[display] = uri
        } else {
            val dir = File(activity.getExternalFilesDir(null), "Yoink").apply { mkdirs() }
            val target = File(dir, file.name)
            file.copyTo(target, overwrite = true)
            savedUris[display] = Uri.fromFile(target)
        }
        return display
    }

    @Command
    fun progress(invoke: Invoke) {
        val args = invoke.parseArgs(JobArgs::class.java)
        val job = jobs[args.jobId]
        val o = JSObject()
        if (job == null) {
            o.put("active", false)
            invoke.resolve(o)
            return
        }
        o.put("active", job.active)
        o.put("processing", job.processing)
        o.put("downloadedBytes", job.percent)
        o.put("totalBytes", 100)
        job.speed?.let { o.put("speed", it) }
        job.eta?.let { o.put("eta", it) }
        o.put("part", job.part)
        o.put("totalParts", job.totalParts)
        invoke.resolve(o)
    }

    @Command
    fun cancelDownload(invoke: Invoke) {
        val args = invoke.parseArgs(JobArgs::class.java)
        jobs[args.jobId]?.cancelled = true
        try {
            YoutubeDL.getInstance().destroyProcessById(args.jobId)
        } catch (_: Exception) {
        }
        invoke.resolve()
    }

    // ── Notifications + the system Downloads app ───────────────────
    // Android 13+ asks before an app may post notifications
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            activity.runOnUiThread {
                activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
            }
        }
    }

    private fun notifyDone(display: String) {
        try {
            val manager = activity.getSystemService(Activity.NOTIFICATION_SERVICE) as NotificationManager
            val channel = "downloads"
            if (Build.VERSION.SDK_INT >= 26) {
                manager.createNotificationChannel(NotificationChannel(channel, "Downloads", NotificationManager.IMPORTANCE_DEFAULT))
            }
            val uri = savedUris[display]
            val view = Intent(Intent.ACTION_VIEW).apply {
                if (uri != null) setDataAndType(uri, activity.contentResolver.getType(uri) ?: "*/*")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val pending = PendingIntent.getActivity(activity, display.hashCode(), view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(activity, channel) else Notification.Builder(activity)
            val notification = builder
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Yoinked!")
                .setContentText(display.substringAfterLast('/'))
                .setSubText("Saved to Download/Yoink")
                .setContentIntent(pending)
                .setAutoCancel(true)
                .build()
            manager.notify(display.hashCode(), notification)
        } catch (_: Exception) {
            // no permission or no notification service — the in-app list still shows it
        }
    }

    @Command
    fun openDownloads(invoke: Invoke) {
        try {
            activity.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("No Downloads app found.")
        }
    }

    // A saved file is found again by name, so this works after the app has been closed
    private fun uriFor(display: String): Uri? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return savedUris[display]?.takeIf { File(it.path ?: "").exists() }
        }
        val name = display.substringAfterLast('/')
        val folder = display.substringBeforeLast('/') + "/"
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        activity.contentResolver.query(
            collection,
            arrayOf(MediaStore.Downloads._ID),
            "${MediaStore.Downloads.DISPLAY_NAME}=? AND ${MediaStore.Downloads.RELATIVE_PATH}=?",
            arrayOf(name, folder),
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val uri = ContentUris.withAppendedId(collection, cursor.getLong(0))
                savedUris[display] = uri
                return uri
            }
        }
        return null
    }

    @Command
    fun fileExists(invoke: Invoke) {
        val args = invoke.parseArgs(RevealArgs::class.java)
        invoke.resolve(JSObject().put("exists", uriFor(args.path) != null))
    }

    @Command
    fun reveal(invoke: Invoke) {
        val args = invoke.parseArgs(RevealArgs::class.java)
        val uri = uriFor(args.path)
        if (uri == null) {
            invoke.reject("That file isn't available any more.")
            return
        }
        try {
            val type = activity.contentResolver.getType(uri) ?: "*/*"
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, type)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("No app found to open this file.")
        }
    }

    // only the credits link
    @Command
    fun openUrl(invoke: Invoke) {
        val args = invoke.parseArgs(UrlArgs::class.java)
        if (!args.url.startsWith("https://github.com/")) {
            invoke.reject("Blocked link.")
            return
        }
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(args.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        invoke.resolve()
    }
}
