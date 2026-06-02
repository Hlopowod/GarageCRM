# Codex Build Notes

Use this file as the short memory for repeated Android/Windows release work.

## Android APK startup crash

- Keep `#[cfg_attr(mobile, tauri::mobile_entry_point)]` above `pub fn run()` in `src-tauri/src/lib.rs`.
- Before releasing an APK, verify the JNI symbol inside each native library, especially `Java_com_garagecrm_app_WryActivity_create`.
- If the app "keeps stopping" on launch, check the native entry point before rebuilding the same APK again.
- If logcat shows `Abort message: 'No provider set'` from `reqwest`/`rustls`, install the rustls crypto provider at process startup before Tauri/WebView can create any HTTP client.
- Android release webviews should keep `app.windows[].useHttpsScheme=true` so Tauri's internal origin is `https://tauri.localhost` instead of `http://tauri.localhost`.
- If a release build opens a black WebView error page that visibly shows `tauri.localhost`, patch the generated Android `RustWebViewClient.shouldInterceptRequest` to serve only `https://tauri.localhost/` and `/assets/...` from `context.assets` with `/` mapped to `index.html`, then rebuild Gradle. Do not remap `ipc.localhost`; Tauri IPC should still be handled by the native request handler.

## Windows Android build quirk

- On this Windows machine, the Tauri Android CLI can fail while creating symlinks for multiple ABIs.
- Reliable workaround: build each Android Rust target with the NDK linker, then let Gradle copy the produced `libgarage_crm_lib.so` into `src-tauri/gen/android/app/src/main/jniLibs/<abi>/`.
- If Gradle says build succeeded but the APK still uses old native code, check the timestamps in `src-tauri/gen/android/app/src/main/jniLibs`.
- After Tauri Android build commands, re-check `src-tauri/gen/android/app/tauri.properties`; Tauri may reset `versionCode`.
- Final APK verification should include `apksigner verify`, `aapt dump badging`, and a check that all expected `jniLibs` ABIs are inside the APK.
- Google Play package name is `com.garagecrm.app`; do not build/upload `com.garagecrm`.
- For a Google Play icon-only rejection, do not mix current source with the last working release. Rebuild from the last known working Android web assets and native libraries, change only launcher PNG resources and `versionCode`, then verify the icon. Keep the launcher as PNG resources, not adaptive icon XML, unless a real-device smoke test confirms the adaptive build opens.

## Cross-device cloud sync

- The app uses local SQLite per device plus a Supabase whole-account snapshot table: `garage_account_snapshots`.
- It is not row-level realtime sync. A device must push a snapshot after local changes, and other devices must pull when the remote snapshot is newer.
- The Windows app previously loaded cloud data only on startup/login/manual restore, so new tablet data would not appear while Windows stayed open.
- The Windows app now polls/focus-refreshes remote snapshot status and restores when `synced_at` is newer than local `state.cloud.last_synced_at`.
- Cloud session remember should stay long-lived; do not reintroduce the old 8-hour remember gate that caused session/local-data clearing surprises.

## Password recovery

- Supabase reset-password emails must use `redirectTo=garagecrm://auth/callback`; otherwise Supabase falls back to the project Site URL, which was `localhost`.
- Supabase Dashboard -> Authentication -> URL Configuration must allow-list `garagecrm://auth/callback`.
- Android builds need both the manifest intent-filter for `garagecrm://auth/callback` and the Android dependency `tauri-plugin-deep-link`; otherwise the link may open but the Tauri plugin will not receive it.
