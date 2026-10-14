# Changelog

All notable changes to `pi-provider-neon-ai-gateway` are documented here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- 13 new Claude chat models from `https://neon.com/models.json`: `claude-fable-5`, `claude-fable-5-1`, `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-opus-4-1`, `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`. Regenerate the catalog with `npm run update-models`.
- `neon-anthropic` provider exposes the same 13 Claude models on the `/anthropic/v1/messages` endpoint. Use it from the `/model` picker to get extended thinking (`thinking` with `budget_tokens`) and prompt caching (`cache_control` on content blocks), neither of which chat completions can forward. Reuses the same `NEON_AI_GATEWAY_TOKEN` and branch URL; pricing and capability metadata are shared with the chat catalog.
- 10 more chat models from `https://neon.com/models.json`: `claude-haiku-5-5`, `claude-sonnet-5-5`, `deepseek-v4-1-flash`, `gemini-3-7-flash`, `gemini-3-8-flash`, `glm-5-3`, `gpt-6-1-sol`, `gpt-6-luna`, `gpt-6-sol`, `grok-4-7`. Regenerate the catalog with `npm run update-models`.
- `neon-anthropic` provider now also covers `claude-haiku-5-5` and `claude-sonnet-5-5`. The set is hardcoded in `scripts/update-models.ts` and reconciled with the upstream Anthropic Messages docs.
- `npm run test:smoke` now picks the provider from the model id. `claude-*` models route to the `anthropic-messages` flow; everything else keeps the `openai-completions` flow. Run a model from the Anthropic catalog with the same env vars to exercise the new provider.

### Changed

- `scripts/update-models.ts` owns the `ANTHROPIC_MODEL_IDS` set and emits the `ANTHROPIC_MODELS` array in the generated `src/models.ts`. The next regen no longer drops the anthropic catalog.

### Fixed

- `claude-opus-5-5` returned an empty string when it reasoned. The Neon gateway sends `message.content` as a list of `reasoning` and `text` blocks; pi-ai's openai-completions parser expects a string. The streaming normalizer flattens the list into the `content` plus `reasoning_content` shape the `gpt-oss` harmony adapter uses.
- `gemini-3-7-flash` and `gemini-3-8-flash` no longer send `frequency_penalty` and `presence_penalty` to the gateway. The two Gemini branches in `transformNeonPayload` collapsed into one `/^gemini-3-/u` regex so every Gemini 3 model inherits the same penalty stripping, with a regression test that loops the catalog.

### Notes

- `gpt-6-luna` does not need the `gpt-5-6-luna` `reasoning_effort: "none"` workaround. The upstream catalog lists `reasoning_options.values` for `gpt-6-luna` as `["low", "medium", "high", "xhigh", "max"]` (no `"none"`), so the existing fix would be rejected. The default "unknown model" path is correct.
- All `gemini-3-*` models on the chat completions provider return 400 with `Unknown name "stream_options" at 'generation_config'`. The pre-existing gateway translation does not strip `stream_options` before forwarding to the Gemini upstream, and the new Gemini 3.6/3.7/3.8 models validate the request body strictly. This is a Neon gateway issue, not an extension issue, and affects the existing `gemini-3-6-flash` the same way as the new arrivals. The chat completions path cannot talk to any Gemini model today.
- The new Claude 5.5 family (`claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5`) on the `anthropic-messages` provider returns 400 because pi-ai's anthropic-messages implementation sends `thinking: {"type": "disabled"}` by default, and these models only accept `between_tools` or `adaptive` with `output_config.effort`. Use the chat completions provider (`/model` picker, `neon` provider) for these models until pi-ai is updated. The older Claude 4.5/4.6/4.7/4.8 models on the anthropic provider still work.

## v0.3.0 - 2026-09-23

### Added

- `/neon-org list` shows every org the management key can access, with the active org marked.
- `/neon-org use <id|name>` switches the active org and persists it under `neon.orgId` in `auth.json`. Match is case-insensitive on exact id or name.
- `/neon-balance` and `/neon-spending-limit` now resolve the active org through `resolveActiveOrg`. When `neon.orgId` is absent, the extension auto-selects the first org from `/users/me/organizations` and persists it. When set, the extension uses it directly without re-discovering.
- `.github/CODEOWNERS` with `@randoneering` as the default reviewer for the repository.

### Documentation

- README rewritten to document `/neon-balance`, `/neon-spending-limit`, `/neon-cap-block`, `/neon-models`, `/neon-limits`, and `/neon-org`. The old "prepaid balance is not exposed" claim is replaced with the real `aigw_credits/balance` endpoint and the real command output.
- Nix config snippet for the `neon-cap` powerline-footer status added.

## v0.2.3 - 2026-09-23

### Added

- Real AI Gateway credit balance in `/neon-balance` via the `GET /organizations/{org_id}/billing/aigw_credits/balance` endpoint. The output now shows the balance with its `as_of` timestamp and recomputes `Headroom` using the smaller of the spending cap and the credit balance.
- `/neon-cap-block on` / `off` / `status` opt-in guard that prevents agent turns when local spend reaches the binding limit. Disabled by default. Persists `capBlockEnabled` on the existing `neon` auth entry. Fails open when the management API cannot verify the limit.
- `/neon-models` lists every Neon model with input, output, and cache-read pricing per million tokens.
- `/neon-limits` shows the latest upstream rate-limit headers (`Retry-After`, `X-Ratelimit-{Limit,Remaining,Reset}-{Requests,Tokens}`) captured by the `after_provider_response` hook.
- `neon-cap` status published to the powerline-footer extension so the cap and local-spend percentage render in the footer without changing the picker.

## v0.2.2 - 2026-09-23

### Added

- Cap-threshold notifications via a `before_agent_start` hook. The hook warns once per session when local Neon spend crosses 50%, 80%, or 95% of the configured spending cap. The cap is cached for 15 minutes so the hook does not hit the management API on every turn.

## v0.2.1 - 2026-09-22

### Fixed

- 429 `REQUEST_LIMIT_EXCEEDED` responses now surface the `Retry-After` value as `; retry after Ns` in the streamed error message. The helper is no-op when `Retry-After` is missing, malformed, zero, non-positive, or when the 429 has a different error code.

## v0.2.0 - 2026-09-22

### Added

- `/neon-balance` shows the org spending cap and this machine's cumulative Neon spend. The cap is read from the public Neon management API at `/organizations/{org_id}/billing/spending_limit`. Local spend is aggregated from session JSONL files under `~/.pi/agent/sessions/`. Requires a separate `napi_...` management key, prompted optionally by `/neon-login` or accepted via the `NEON_API_KEY` env var.
- `/neon-login` now optionally prompts for a Neon management API key. `/neon-status` reports whether the key and a cached org id are configured.
- `/neon-spending-limit` shows the current org spending cap and caches the resolved org id in `auth.json` for reuse by `/neon-balance`.

### Fixed

- Fall back to the process environment when a stored gateway URL is empty.
- Reject shell-expression tokens during `/neon-login` instead of allowing pi to evaluate them.
- Return a streamed configuration error for malformed gateway base URLs.
- Harden SSE handling for partial lines, leading whitespace, multiline data, and passthrough lines.
- Normalize flat and JSON error responses consistently, including responses without a standard JSON content type.
- Reconcile model metadata with Neon's catalog and apply model-specific request field rules.
- Keep the GPT-5.6 Luna tool workaround that forces `reasoning_effort: "none"`.
- Pin the tested pi core packages and add package and release workflow checks.

## v0.1.3 - 2026-09-19

### Added

- Documentation: `AGENTS.md` linking to the Neon AI Gateway docs.
- Project guidance for pull requests and agents.

### Fixed

- Harden gateway config validation and stream handling.

## v0.1.2 - 2026-09-19

### Fixed

- Internal hardening of the request transformer and stream normalizer.

## v0.1.1 - 2026-09-18

### Fixed

- Initial fixes after the first npm publish.

## v0.1.0 - 2026-09-18

### Added

- Initial release of `pi-provider-neon-ai-gateway`.
- Registers the Neon AI Gateway as a model provider in pi.
- Commands: `/neon-login`, `/neon-status`, `/neon-logout`.
- Per-model cleanup of OpenAI fields that Neon's upstream rejects (`store`, `prompt_cache_key`, `prompt_cache_retention`, `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `temperature`, `top_p`, `reasoning_effort`).
- GPT-OSS harmony-to-flat-content translation.
- Neon `{ error: { message } }` envelope unwrapping.
- Supports all 34 Neon AI Gateway models at the time of release.
