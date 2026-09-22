# Changelog

## Unreleased

### Added

- `/neon-balance` shows the org spending cap (from the public Neon management API) plus this machine's cumulative Neon spend across local session files. Requires a separate `napi_...` management key, prompted by `/neon-login` (optional) or accepted via the `NEON_API_KEY` env var.
- `/neon-login` now optionally prompts for a Neon management API key. `/neon-status` reports whether the key and a cached org id are configured.

### Fixed

- Fall back to the process environment when a stored gateway URL is empty.
- Reject shell-expression tokens during `/neon-login` instead of allowing pi to evaluate them.
- Return a streamed configuration error for malformed gateway base URLs.
- Harden SSE handling for partial lines, leading whitespace, multiline data, and passthrough lines.
- Normalize flat and JSON error responses consistently, including responses without a standard JSON content type.
- Reconcile model metadata with Neon’s catalog and apply model-specific request field rules.
- Keep the GPT-5.6 Luna tool workaround that forces `reasoning_effort: "none"`.
- Pin the tested pi core packages and add package and release workflow checks.
