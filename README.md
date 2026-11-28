# tvek for Visual Studio Code

Fast RFC 8259 JSON and JSONC linting, formatting, and syntax auto-fixing for Visual Studio Code, powered by [`tvek`](https://github.com/Xpt0xZv/tvek)'s built-in Rust Language Server (`tvek server`).

## Features

- **Real-Time Diagnostics**: Instant syntax validation for `json` and `jsonc` files (`file:` and `untitled:` buffers), catching trailing commas, single-quoted strings, unquoted keys, malformed escapes, and disallowed comments (when `tvek.strict` is enabled).
- **Deterministic Formatting**: Whole-document formatting honoring VS Code's per-editor `insertSpaces` and `tabSize` alongside `tvek.sortKeys`, `tvek.lineWidth`, `tvek.structural`, and `tvek.minify`.
- **One-Step Auto-Fix (`source.fixAll.tvek`)**: Quick-fix code actions and save-time syntax repair for fixable JSON/JSONC syntax issues.
- **Defense-in-Depth Workspace Trust**: Protects untrusted workspaces against workspace binary hijacking, `.venv` planting, and workspace-relative `PATH` traversal.
- **Zero Telemetry & Minimal Footprint**: Single bundled CommonJS entrypoint with zero runtime network requests.

## Quick Start (`settings.json`)

To configure `tvek` (`xpt0xzv.tvek-vscode`) as your default JSON/JSONC formatter with format-on-save and automatic syntax repair on save, add the following to your VS Code `settings.json`:

```json
{
  "[json]": {
    "editor.defaultFormatter": "xpt0xzv.tvek-vscode",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
      "source.fixAll.tvek": "explicit"
    }
  },
  "[jsonc]": {
    "editor.defaultFormatter": "xpt0xzv.tvek-vscode",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
      "source.fixAll.tvek": "explicit"
    }
  }
}
```

## Installation

1. Install **tvek** from the Visual Studio Code Marketplace (or Open VSX). Platform-specific VSIX packages bundle the verified `tvek` native binary automatically.
2. Alternatively, install `tvek` into your project `.venv` (`pip install tvek`) or system `PATH` (`cargo install tvek`) and set `"tvek.importStrategy": "fromEnvironment"` in a trusted workspace.

### Building from Source

```bash
npm install
npm run fetch-binary
npm run build
npx @vscode/vsce package
```

## Workspace Trust & Security Model

`tvek-vscode` supports VS Code Workspace Trust (`"supported": "limited"`) with strict binary and configuration isolation:

- **Trusted Workspaces**:
  1. If `tvek.path` is set, resolves and validates that exact executable (fails closed without silent fallback if missing or invalid).
  2. With `"tvek.importStrategy": "useBundled"` (default): `<extension>/bundled/bin/tvek[.exe]` -> `<workspace>/.venv/{Scripts/tvek.exe | bin/tvek}` -> sanitized `PATH`.
  3. With `"tvek.importStrategy": "fromEnvironment"`: `<workspace>/.venv/{Scripts/tvek.exe | bin/tvek}` -> sanitized `PATH` -> `<extension>/bundled/bin/tvek[.exe]`.
- **Untrusted Workspaces (Restricted Mode)**:
  - Workspace-level `.vscode/settings.json` and `.code-workspace` overrides for `tvek.*` are ignored; only user-level (`globalValue`) or default settings are read.
  - `tvek.path` is forced to `null` and `tvek.importStrategy` is forced to `"useBundled"`.
  - Workspace `.venv` directories are never searched, and any `PATH` entry or symlink target resolving inside a workspace folder is rejected.
  - All child processes run with `shell: false`, `cwd` pinned to the extension installation directory, and `NoDefaultCurrentDirectoryInExePath=1`.

## Configuration

Changes to any `tvek.*` setting automatically restart the `tvek` language server with updated initialization options.

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `tvek.enable` | `boolean` | `true` | Enable or disable the `tvek` JSON and JSONC language server. |
| `tvek.path` | `string \| null` | `null` | Explicit filesystem path to the `tvek` executable *(Trusted workspaces only)*. |
| `tvek.importStrategy` | `"useBundled" \| "fromEnvironment"` | `"useBundled"` | Order in which `tvek-vscode` searches for the `tvek` executable *(Trusted workspaces only)*. |
| `tvek.sortKeys` | `boolean` | `false` | Sort object keys lexicographically during document formatting. |
| `tvek.strict` | `boolean` | `false` | Enforce strict RFC 8259 JSON by disallowing `//` and `/* */` comments. |
| `tvek.structural` | `boolean` | `false` | Expand all non-empty arrays across multiple lines (forces `lineWidth` to `0`). |
| `tvek.lineWidth` | `number` | `80` | Maximum target line width for inline array compaction (`0..=4096`). |
| `tvek.minify` | `boolean` | `false` | Format JSON documents into compact single-line output without insignificant whitespace. |
| `tvek.maxSize` | `number` | `104857600` | Maximum document size in bytes accepted by `tvek server` (`1..=104857600`, 100 MiB). |
| `tvek.trace.server` | `"off" \| "messages" \| "verbose"` | `"off"` | Trace LSP JSON-RPC messages between VS Code and the `tvek` server. |

## Commands

| Command ID | Command Palette Title | Description |
| :--- | :--- | :--- |
| `tvek.restartServer` | `tvek: Restart Language Server` | Cleanly stop and restart the `tvek` language server process. |
| `tvek.fixAll` | `tvek: Fix All Auto-Fixable JSON Syntax Issues` | Apply `source.fixAll.tvek` workspace edits to the active JSON/JSONC editor. |
| `tvek.showLogs` | `tvek: Show Output Channel` | Reveal the `tvek` Output Channel for version, binary source, and server diagnostics. |

## License

Dual-licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT License ([LICENSE-MIT](LICENSE-MIT) or <http://opensource.org/licenses/MIT>)

at your option.
