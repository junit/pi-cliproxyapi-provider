# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Dual-Protocol Support**: Auto-detects and supports the standard OpenAI Responses API (`openai-responses`) over HTTP SSE for third-party proxy/relay stations, alongside the official ChatGPT Codex backend protocol (`openai-codex`). (#14)
- **Protocol Configuration**: Added `protocol` field (`"openai-codex" | "openai-responses"`) to `cliproxyapi.json` and `CLIPROXYAPI_PROTOCOL` environment variable override.
- **Physical Module Resolution Pipeline**: Implemented a comprehensive multi-root probe pipeline for locating `@earendil-works/pi-ai` distribution files across pi 0.84.3+ bundled runtime, OMP CLI, NVM, and global installations. (#14)
- **Unit Test Coverage**: Added dedicated test suites for runtime stream patching, module resolution, and cache protocol awareness.

### Fixed
- **Per-Model Max Output Tokens Resolution**: Derived `maxTokens` dynamically from upstream `max_tokens`, `max_output_tokens`, and `max_completion_tokens` instead of hardcoding `DEFAULT_MAX_TOKENS` (16384), unlocking the full 128K output capabilities of models like Claude Sonnet 5 and Opus. (#11)
- **OMP Runtime Compatibility**: Resolved `TypeError: settingsManager.reload is not a function` during extension initialization under OMP (`omp/18.0.4`) by supporting async `SettingsManager.create()`, disk reload fallback, and resilient compaction configuration extraction. (#13)
- **Relay API WebSocket Errors**: Resolved `WebSocket error` and retry failures when connecting to third-party proxy stations that only support HTTP SSE at `/v1/responses`.
- **Cache Protocol Consistency**: Fixed model cache lookup to be protocol-aware, preventing endpoint collisions between Codex (`/backend-api/`) and Relay API (`/v1/`) modes.
- **pi 0.84.3 Bundled Runtime Crash**: Fixed `Cannot resolve openai-codex-responses.js (tried: none)` failure caused by virtual module loader bypass in pi 0.84.3 bundled mode. (#14)

## [1.4.14] - 2026-03-24

### Fixed
- Resolved bundled pi-ai module path resolution under packaged CLI environments.
- Prevented stale TPS context references after session replacement or reload.
- Styled paused footer labels with orange indicator color.

### Added
- Provider request pause and resume controls (`/pause` and `/continue`).

## [1.4.13] - 2026-03-20

### Performance
- Coordinated model catalog refreshes with cache-aware startup updates.
- Added cached `models.dev` pricing fallbacks for offline and resilient startup.
- Fixed Fast pricing refresh consistency.

## [1.4.10] - 2026-03-15

### Reliability
- Added automatic retry logic for transient Codex stream network errors and closed connections.
- Improved WebSocket reconnection fallback handling.

## [1.4.8] - 2026-03-10

### Compatibility
- Upgraded compatibility for pi `0.82.0`+.
- Streamlined `/login` OAuth multi-field configuration workflow.

## [1.4.0] - 2026-03-01

### Added
- Added global Fast mode toggle (`/fast`) for catalog-supported models.
- Integrated `models.dev` priority service tier pricing.
