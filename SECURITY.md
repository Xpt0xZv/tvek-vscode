# Security Policy

## Supported Versions

Security updates are applied to the latest minor release series of `tvek-vscode`.

| Version | Supported |
| :--- | :--- |
| `0.1.x` | Yes |
| `< 0.1.0` | No |

## Reporting a Vulnerability

Please **do not** report suspected security vulnerabilities through public GitHub issues, discussions, or pull requests.

Instead, report vulnerabilities privately via **[GitHub Private Vulnerability Reporting](https://github.com/Xpt0xZv/tvek-vscode/security/advisories/new)**.

### Response Timeline & Coordinated Disclosure

- **Acknowledgement**: Within **48 hours** of submission.
- **Triage & Severity Assessment**: Within **5 business days**, including reproduction confirmation, affected version scope, and remediation plan.
- **Coordinated Disclosure**: Once a patched release is published to the Visual Studio Code Marketplace, Open VSX, and GitHub Releases, we publish a coordinated GitHub Security Advisory crediting the reporter (unless anonymity is requested).

Please include:
1. Extension version (`tvek-vscode`), `tvek` binary version (`tvek --version`), VS Code version, and OS/architecture.
2. Workspace Trust state (`Trusted` vs `Restricted Mode`) and relevant `tvek.*` settings.
3. Minimal reproduction steps or proof-of-concept configuration/archive payload.

## Security Architecture & Invariants

`tvek-vscode` enforces defense-in-depth boundaries across untrusted workspaces, child process execution, LSP responses, and binary packaging (see [ADR-0001](docs/adr/0001-tvek-vscode-architecture-and-trust-model.md)):

- **VS Code Workspace Trust (`untrustedWorkspaces: "limited"`)**:
  - In untrusted workspaces, workspace-scoped `.vscode/settings.json` and `.code-workspace` values are ignored unconditionally; only user-level (`globalValue`) or default settings are read.
  - `tvek.path` is forced to `null` and `tvek.importStrategy` is forced to `"useBundled"`.
  - Project `.venv` directories are never searched, and `PATH` sanitization strips empty/relative entries, raw Win32 device namespaces (`\\.\`, `\\?\Volume{...}`), NTFS Alternate Data Streams, Win32 trailing-dot/trailing-space directory aliases, UNC share aliases, and any `PATH` directory or `fs.realpath` symlink target resolving inside an untrusted workspace folder.
- **Hardened Child Process Spawning**:
  - Executables are resolved to canonical absolute paths (`fs.realpath`) rather than bare command names.
  - Every `--version` probe and `tvek server` child process spawns with `shell: false`, `cwd` pinned to the extension installation directory (never a workspace folder), `NoDefaultCurrentDirectoryInExePath=1`, and case-insensitive stripping of `ELECTRON_RUN_AS_NODE` for native binaries.
- **LSP Command-Gadget Isolation**:
  - Code actions returned by the language server are restricted strictly to declarative `WorkspaceEdit` payloads (`CodeAction.edit`); server-supplied `CodeAction.command` invocations are stripped in both `LanguageClient` middleware and the `tvek.fixAll` command.
- **Supply-Chain & Archive Extraction Hardening (`scripts/fetch-binary.mjs`)**:
  - Release downloads enforce `https:` (`TLSv1.2+`) with redirects allowlisted strictly to `github.com` and `*.githubusercontent.com`.
  - Archive bytes are verified against `SHA256SUMS` using constant-time `crypto.timingSafeEqual` **before** any decompression or header parsing occurs.
  - `.zip` and `.tar.gz` archives are extracted in-memory in pure Node.js (`node:zlib`) with USTAR checksum and CRC-32 validation, rejecting `..` traversal segments, leading slashes, Windows drive prefixes, symlinks, hardlinks, and special device nodes.

## Verifying Release Artifacts

Official `.vsix` packages attached to GitHub Releases include cryptographic SLSA build provenance attestations and `SHA256SUMS` digests.

### 1. Verify SLSA Build Provenance (GitHub CLI)

```bash
gh attestation verify tvek-vscode-<target>-<version>.vsix --repo Xpt0xZv/tvek-vscode
```

### 2. Verify SHA-256 Checksums

```bash
sha256sum -c SHA256SUMS --ignore-missing
```
