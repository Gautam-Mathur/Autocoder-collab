# Reproducible build steps for the AutoCoder desktop binaries

These instructions assume a clean macOS / Linux / Windows host. They are NOT runnable inside the Replit container (no Rust + webview2 toolchain).

## macOS

```bash
brew install rustup-init && rustup-init -y
source $HOME/.cargo/env
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cargo install tauri-cli@^2.0

# In repo root
pnpm install
pnpm --filter @workspace/autocoder run build
pnpm --filter @workspace/api-server run build

cd desktop
cargo tauri build --target universal-apple-darwin
# Output: target/universal-apple-darwin/release/bundle/dmg/AutoCoder_<v>_universal.dmg
```

## Linux (Debian/Ubuntu)

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl wget
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source $HOME/.cargo/env
cargo install tauri-cli@^2.0

cd desktop
cargo tauri build
# Outputs: target/release/bundle/{appimage,deb}/
```

## Windows

```powershell
winget install --id Rustlang.Rustup
rustup install stable
cargo install tauri-cli --version ^2.0

cd desktop
cargo tauri build
# Output: target\release\bundle\msi\AutoCoder_<v>_x64_en-US.msi
```

## Code signing (optional, required for distribution)

| Platform | Tool                          | Where to configure       |
|----------|-------------------------------|--------------------------|
| macOS    | `codesign` + `notarytool`     | `tauri.conf.json` > `bundle.macOS.signingIdentity` |
| Windows  | `signtool` + EV cert          | `tauri.conf.json` > `bundle.windows.certificateThumbprint` |
| Linux    | None required for AppImage    | n/a                      |

## CI

A reference GitHub Actions workflow that builds all three platforms is **not** included here — the Tauri team's `tauri-action` is the recommended starting point. See https://github.com/tauri-apps/tauri-action.
