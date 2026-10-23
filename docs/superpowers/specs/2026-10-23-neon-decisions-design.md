# Optional Neon decision models

## Approved behavior

- Add `neon_decide` for Jev 1.14 and OpenJev through `/typesafe/v1/systemone`.
- Keep decision models out of the chat picker and add Gemini 4 Argon to chat.
- Default decision support to disabled.
- Provide `/neon-decide enable`, `/neon-decide disable`, and `/neon-decide status`.
- Apply changes immediately and persist the preference across sessions.
- Disabled tools are hidden and reject new calls, including stale tool declarations.
- Disabling does not cancel a request that already started.
- Reuse gateway credentials without adding an SDK dependency.

## Components

| File | Responsibility |
|---|---|
| `scripts/update-models.ts` | Filter non-chat types and generate a separate decision catalog with published input prices |
| `src/models.ts` | Generated chat and decision metadata |
| `src/decisions.ts` | Question schemas, request validation, credential resolution, HTTP, response checks, usage |
| `src/decision-tool.ts` | Persist preference, register tool and slash command, enforce disabled state |
| `src/config.ts` | Normalize the decision endpoint with existing credential precedence |
| `src/account.ts` | Include decision tool usage in local Neon spend |
| `src/index.ts` | Register decision support |

## Tool interface

`neon_decide` accepts `state` as text or a JSON object, a nonempty record of named questions, and an optional `model`.
The default model is `typesafeai-jev-1-14-0`; the alternative is `openjev-qwen35-4b`.
Questions use `noul`, `choice`, or `score`, following Neon's documented wire format.
Choice questions require at least two named options; score questions require at least two levels.
Reject unknown models, unsupported question types, invalid criteria, and empty instructions before sending a request.

Return validated answers and raw gateway token counts as structured data, plus pi usage with input-only costs.
Do not send tools, streaming fields, or chat messages to the decision endpoint.
Use a 30-second timeout and honor caller cancellation.
Reject redirects, malformed responses, missing answers, and invalid probabilities.
Surface actionable status-based errors without echoing credentials, state, or raw response bodies.
Do not retry paid requests automatically.

## Credentials and preference

Use the stored `neon` credential, falling back to the existing alternate Neon credentials and environment variables when absent.
Stored credential environment values take precedence over process environment values.
Reject shell-expression token values starting with `!` or `$`.
Store only `{ "enabled": boolean }` in `neon-decisions.json` under pi's agent directory.
Keep the preference independent from login and logout; write it atomically.
A missing file means disabled; an unreadable or invalid file fails closed.
The execution guard checks the persisted preference so stale declarations cannot bypass disabling.

## Catalog and Gemini

Filter explicit non-chat model types before generating chat entries; retain backward compatibility for entries without a type.
Generate decision IDs, names, and published input prices without inventing output limits.
Preserve existing Responses-only and unreleased filters.
Live checks confirm Gemini 4 needs the existing tool-signature and finish-reason normalization.
The chat gateway rejects `reasoning_effort`; omit that field and document that Gemini 4 uses its default thinking behavior.
Do not invent a native thinking mapping.
Preserve the GPT-5.6 Luna tool-effort workaround and canonical model IDs.

## Tests and handoff

Use Vitest regression tests for catalog filtering, request schemas, endpoint normalization, credential precedence, HTTP failures, malformed answers, aborts, input-only billing, default-off behavior, persistence, immediate toggling, and stale calls.
Keep network tests isolated from real credentials.
Update README, CHANGELOG, and the project file index.
Run `npm run check`, `npm test`, and `npm pack --dry-run`.
Run live Gemini and decision smoke checks when gateway credentials are available, and report skipped checks.
Do not bump the package version.

## References

- https://neon.com/docs/changelog/2026-10-23
- https://neon.com/docs/ai-gateway/decisions
- https://neon.com/docs/ai-gateway/models
- https://neon.com/models.json
