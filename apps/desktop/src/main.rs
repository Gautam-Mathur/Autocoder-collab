// AutoCoder Desktop — Tauri shell (Initiative G).
//
// In dev mode this just opens a window pointed at the Vite dev server.
// In a production build it should spawn the bundled Express API server as
// a sidecar process and pass the assigned port to the frontend.
//
// The API-server-as-sidecar wiring is intentionally a placeholder — local
// development runs both processes manually so the shell stays simple while
// we iterate on the desktop build.

#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

fn main() {
  tauri::Builder::default()
    .setup(|_app| {
      // TODO(initiative-g): spawn `node ../artifacts/api-server/dist/server.cjs`
      //   as a sidecar in release builds. For now the user starts it manually.
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
