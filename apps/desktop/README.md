# AutoCoder Desktop (Tauri) — Initiative G

Native desktop wrapper for AutoCoder. Bundles the Vite frontend (`artifacts/autocoder`) and proxies API calls to a sidecar copy of the Express API server (`artifacts/api-server`). Bring-your-own-LLM via Ollama / LM Studio — no cloud calls required.

> **Status: Scaffolding only.** The Tauri toolchain (Rust + system webview deps) is not installable inside the Replit container, so this directory is documentation + reproducible build files. Build locally with the steps below.

## Why a desktop build?

- **Offline-first**: pair with Ollama for fully local, zero-cloud generation.
- **Filesystem access**: open and write to a real project directory instead of `localStorage`.
- **One double-click install**: ship `.dmg`, `.msi`, `.AppImage` artefacts to non-developer users.
- **Single distribution unit**: the Tauri binary spawns the Express API as a sidecar so installers don't need Node.

## Prerequisites

- Rust 1.78+ (`rustup install stable`)
- Node.js 24, pnpm 9 (already required by the monorepo)
- Platform deps:
  - **macOS**: Xcode CLT (`xcode-select --install`)
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
  - **Windows**: Microsoft C++ Build Tools, WebView2 Runtime
- Tauri CLI: `cargo install tauri-cli@^2.0`

## One-time setup

```bash
# From the monorepo root
pnpm install
pnpm --filter @workspace/autocoder run build
pnpm --filter @workspace/api-server run build
```

## Development

```bash
cd desktop
cargo tauri dev
```

This launches the desktop shell pointing at the local dev servers (frontend on 5173, API on 5000). The shared proxy is bypassed — Tauri talks directly to the API.

## Production build

```bash
cd desktop
cargo tauri build
```

Output:
- macOS: `target/release/bundle/dmg/AutoCoder_<version>_<arch>.dmg`
- Linux: `target/release/bundle/appimage/autocoder_<version>_amd64.AppImage`
- Windows: `target/release/bundle/msi/AutoCoder_<version>_x64.msi`

## Configuration

See `tauri.conf.json` for window size, allowed protocols, and bundle identifiers. Adjust `bundle.resources` to include the prebuilt API server when shipping.

## Sidecar API server

In production builds the Tauri shell spawns the prebuilt API server (`artifacts/api-server/dist/server.cjs`) on a random local port and configures the frontend to talk to it via `localhost`. See `src/main.rs` for the spawn logic. In dev mode the sidecar is skipped — run `pnpm --filter @workspace/api-server run dev` in another terminal.

## Status of feature parity with the web build

| Capability                         | Web | Desktop |
|------------------------------------|-----|---------|
| Chat → plan → generate             | ✅  | ✅      |
| In-browser preview (WebContainer)  | ✅  | ❌ (planned: native subprocess) |
| Project export as zip              | ✅  | ✅      |
| Open project in real file system   | ❌  | ✅      |
| MCP server                         | ✅  | ✅ (same dispatcher) |
| Local Ollama / LM Studio           | ✅  | ✅      |
| Cloud AI fallback                  | ✅  | ✅      |

## Next steps before shipping

1. Code-sign and notarise (`tauri.conf.json` → `bundle.macOS.signingIdentity`).
2. Auto-update via `tauri-plugin-updater`.
3. Replace WebContainer preview with a native subprocess sandbox using `tauri-plugin-shell`.
