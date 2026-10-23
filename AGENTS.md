# Project Agent Guide

## Project

`pi-provider-neon-ai-gateway` is a TypeScript pi extension that registers Neon AI Gateway models through the OpenAI-compatible completions API.

## Repository Layout

- `src/config.ts`: environment and credential configuration.
- `src/auth.ts`: `/neon-login`, `/neon-logout`, and `/neon-status` commands.
- `src/models.ts`: the generated Neon chat and decision model catalogs.
- `src/decisions.ts`: decision question validation, HTTP requests, and input-only usage.
- `src/decision-tool.ts`: optional `neon_decide` tool and persistent `/neon-decide` controls.
- `src/stream.ts`: request transformation, response normalization, and streaming.
- `src/index.ts`: provider registration.
- `test/`: Vitest unit tests and the gateway smoke test.
- `CHANGELOG.md`: unreleased release notes and published version history.

## Neon AI Gateway Documentation

- [AI Gateway overview](https://neon.com/docs/ai/ai-gateway)
- [Chat Completions API](https://neon.com/docs/ai-gateway/chat-completions)
- [Available models](https://neon.com/models.json)

Use the upstream documentation when checking model limits, request fields, authentication, or response behavior.
- `.github/workflows/`: CI and npm publishing workflows.

## Development

- Use Node.js 22 and npm.
- Install dependencies with `npm ci`.
- Run `npm run check` for TypeScript checks.
- Run `npm test` for unit tests.
- Run `npm run test:smoke` and `npm run test:smoke:decisions` only when gateway credentials are available.
- Decision smoke commands make paid requests independently of the default-off tool preference.
- Run `npm pack --dry-run` when changing package contents.

Every behavior change needs a regression test. Keep provider-specific behavior in `src/stream.ts` or a focused helper instead of spreading model rules across the extension.

## Request and Model Rules

- Keep the `gpt-5-6-luna` tool workaround that sets `reasoning_effort` to `none` when tools are present.
- Treat stored credential environment values and process environment values according to `src/config.ts` precedence.
- Reconcile model catalog changes with `https://neon.com/models.json` before editing `src/models.ts`.
- Preserve the canonical model-id handling used by payload transformation and model lookup.
- Do not add unsupported request fields to a model family without a test and an upstream reference.

## Authentication and Secrets

- Never commit tokens, API keys, `auth.json`, or environment files.
- Do not print credential values in tests or diagnostics.
- The live smoke test reads credentials from pi's normal auth configuration.
- Reject shell-expression credential values that begin with `!` or `$`.

## Changes and Commits

- Do not bump `package.json` version. Releases derive versions from git tags.
- Do not edit release-drafter version templates.
- Use conventional commit subjects in the form `type(scope): message`, such as `fix(stream): handle malformed gateway URLs`.
- Keep commits focused and avoid unrelated formatting changes.
- Never use em dashes in documentation, comments, or commit messages.

## Verification Before Handoff

Run both commands before declaring a change complete:

```bash
npm run check
npm test
```

For request or authentication changes, also run the applicable smoke test when credentials are available. Report skipped checks and the reason.

## Pull Requests

Use the repository pull request template. Include the behavior changed, tests run, release impact, and any known limitations. Keep the PR focused on one related set of changes.
