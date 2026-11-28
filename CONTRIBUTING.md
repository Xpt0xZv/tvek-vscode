# Contributing to `tvek-vscode`

Thank you for contributing to `tvek-vscode`! This guide covers local setup, architecture boundaries, verification commands, and pull request standards.

## Prerequisites

- **Node.js `24` LTS** (pinned in [`.nvmrc`](.nvmrc); Node `>= 20.0.0` supported at runtime) and `npm`.
- **Optional `tvek` Binary**: Either fetched automatically from upstream GitHub Releases via `npm run fetch-binary`, built locally from [`Xpt0xZv/tvek`](https://github.com/Xpt0xZv/tvek) with Rust (`cargo build --release`), or exercised offline through the zero-dependency LSP 3.17 mock server (`test/fixtures/mock-tvek-lsp.mjs`).

## Architecture Overview

As documented in [ADR-0001](docs/adr/0001-tvek-vscode-architecture-and-trust-model.md), `src/` is partitioned across a strict boundary enforced by ESLint (`no-restricted-imports`):

1. **Pure-Node Core (`src/types.ts`, `src/config.ts`, `src/mutex.ts`, `src/binary.ts`)**:
   - **Zero** imports of `vscode` or `vscode-languageclient`.
   - Contains Workspace Trust configuration filtering, option clamping, `PATH` and symlink boundary validation, binary discovery, `--version` probing, and `AsyncMutex` / `ReloadCoordinator` concurrency primitives.
   - Tested directly in Node.js (`node --test`) in milliseconds without booting Electron.
2. **VS Code Extension Host Adapters (`src/client.ts`, `src/status.ts`, `src/commands.ts`, `src/extension.ts`)**:
   - Thin integration layer managing `LanguageClient` lifecycle transitions, `LanguageStatusItem` presentation, and VS Code commands (`tvek.restartServer`, `tvek.fixAll`, `tvek.showLogs`).
   - Tested end-to-end inside an isolated VS Code Extension Host via `@vscode/test-cli` (`test/e2e/extension.test.ts`).

## Development Workflow & Commands

Install exact locked dependencies:

```bash
npm ci
```

Typecheck (`tsc --noEmit`) and lint (`eslint`):

```bash
npm run check
```

Bundle the extension (`dist/extension.js` via `esbuild`):

```bash
npm run build
```

Run fast pure-Node unit tests (`node --test`):

```bash
npm run test:unit
```

Run the full test suite (unit tests + VS Code Extension Host E2E tests):

```bash
npm test
```

Fetch and verify the upstream `tvek` binary into `bundled/bin/`:

```bash
# Fetch host platform target from GitHub Releases (verifies SHA256SUMS before extraction)
npm run fetch-binary

# Fetch a specific VS Code target (win32-x64, win32-arm64, darwin-x64, darwin-arm64, linux-x64, linux-arm64, alpine-x64)
npm run fetch-binary -- --target linux-x64

# Or stage a locally compiled tvek binary offline
TVEK_LOCAL_BIN=/absolute/path/to/tvek npm run fetch-binary
```

Package a platform-targeted `.vsix` archive:

```bash
npm run package:vsix -- --target win32-x64
```

## Pull Request & Commit Standards

- **Branching**: Work on a dedicated topic branch (`feat/*`, `fix/*`, `perf/*`, `sec/*`, `ci/*`, `docs/*`, `chore/*`) targeting `main`.
- **Conventional Commits**: Format commit titles as `<type>(<scope>): <summary>` (for example, `fix(binary): strip trailing dots on win32 path segments` or `feat(client): add crash backpressure window`).
- **Verification**: Ensure `npm run check`, `npm run build`, and `npm test` pass with zero errors or warnings, and add unit/E2E regression tests for any bug fix or security boundary change.
- **Dependencies**: Keep `vscode-languageclient` as the sole runtime dependency unless a strong architectural justification is documented in an ADR.

## License

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in `tvek-vscode` by you, as defined in the Apache-2.0 license, shall be dual-licensed under `MIT OR Apache-2.0` ([LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE)), without any additional terms or conditions.
