# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# ── Yoink ────────────────────────────────────────────────────────
# The release build runs R8, which deletes anything nothing references directly.
# Tauri's Rust side loads plugins by NAME at startup and calls their commands by
# reflection, so without these the app crashes the instant it opens.
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep @app.tauri.annotation.InvokeArg class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
}
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# yt-dlp, python and ffmpeg: loaded and driven by reflection / JNI
-keep class com.yausername.** { *; }
-dontwarn com.yausername.**
