# Changelog

All notable changes to `tvek-vscode` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-26

### Added
- Initial release of `tvek-vscode` targeting `tvek` `v0.1.4` (`tvek server` over stdio LSP 3.17).
- Real-time RFC 8259 JSON and JSONC diagnostics, whole-document formatting, quick-fix code actions, and `source.fixAll.tvek` code actions on save.
- Workspace Trust security model restricting `tvek.path`, `tvek.importStrategy`, `.venv`, and workspace `PATH` resolution in untrusted workspaces.
- Serialized `LanguageClient` lifecycle manager with automatic server reload on `tvek.*` setting changes and Workspace Trust grants.
- Status bar `LanguageStatusItem` displaying resolved `tvek` version and executable source (`bundled`, `venv`, `path`, or `custom`).
- Zero-dependency release fetcher (`scripts/fetch-binary.mjs`) supporting all 7 VS Code platform targets with pre-extraction `SHA256SUMS` verification.
