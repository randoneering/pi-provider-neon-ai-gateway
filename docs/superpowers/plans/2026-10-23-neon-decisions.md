# Optional Neon Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Execute inline in the current session; delegation is not requested.

**Goal:** Add optional Jev decision tools and refresh the supported chat catalog.

**Architecture:** Separate decision HTTP handling from preference storage and pi registration.
Generate chat and decision metadata from the same upstream catalog.
Reuse existing credential helpers and report input-only decision costs through tool usage and local spending totals.

**Tech Stack:** TypeScript strict mode, Node.js fetch, pi 1.3.0 TypeBox exports, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-neon-decisions-design.md`

## Global Constraints

- Default decision support to disabled.
- Provide `/neon-decide enable`, `/neon-decide disable`, and `/neon-decide status`.
- Disabled tools are hidden and reject new calls, including stale tool declarations.
- Reuse gateway credentials without adding an SDK dependency.
- Use a 30-second timeout and honor caller cancellation.
- Do not retry paid requests automatically.
- Do not bump the package version.
- Preserve the GPT-5.6 Luna tool-effort workaround and canonical model IDs.

## Task 1: Generate typed catalogs

**Files:** `scripts/update-models.ts`, generated `src/models.ts`, `test/models-generator.test.ts`, `test/models.test.ts`.

**Interfaces:** Add optional `type` to `UpstreamModel`; export generated `DECISION_MODELS` entries containing `id`, `name`, and `inputCost`.

- [x] Add tests that reject `type: "decision"` and `type: "embedding"` from chat regardless of family.

```typescript
expect(isChatModel({ id: "typesafeai-jev-1-14-0", type: "decision" })).toBe(false);
expect(isChatModel({ id: "bge-large-en", type: "embedding" })).toBe(false);
```

- [x] Add catalog tests for Gemini 4 registration, decision exclusion, and published decision prices.
- [x] Run `npm test -- test/models-generator.test.ts test/models.test.ts` and confirm missing behavior fails.
- [x] Filter explicit non-chat types, emit decision metadata, and run `npm run update-models`.
- [x] Run both test files and confirm they pass.

## Task 2: Implement decision requests

**Files:** `src/config.ts`, new `src/decisions.ts`, `test/config.test.ts`, new `test/decisions.test.ts`.

**Interfaces:** Export `decisionParameters`, `decisionOutput`, and `requestNeonDecision(params, options)`.
Options support a literal token, process and credential environments, a fetch implementation, and an abort signal for isolated network tests.
Return gateway `model`, named `answers`, and raw usage; provide a helper to derive pi usage from input-only prices.

- [x] Test normalized `/typesafe/v1/systemone` URLs and stored environment precedence.
- [x] Test a captured request against literal expected payload and headers using fake fetch responses.

```typescript
expect(JSON.parse(capturedBody)).toEqual({
  model: "typesafeai-jev-1-14-0",
  state: "Refund requested",
  questions: { refund: { type: "noul", instructions: "Is a refund requested?" } },
});
```

- [x] Test question validation, both models, unknown IDs, shell-expression tokens, missing auth, malformed answers and usage, redirects, 400/401/403/429/5xx errors, and cancellation.
- [x] Run `npm test -- test/config.test.ts test/decisions.test.ts` and observe failures.
- [x] Add the resolver and native HTTP implementation with request and response schema checks, bounded errors, timeout, no redirects, and no retries.
- [x] Run focused tests and `npm run check`.

## Task 3: Add persistent user controls

**Files:** new `src/decision-tool.ts`, `src/index.ts`, new `test/decision-tool.test.ts`.

**Interfaces:** Export `registerNeonDecisionTool(pi)` and the preference reader; keep atomic preference writes private.
Register `neon_decide` with structured output and `/neon-decide` with `enable`, `disable`, and `status` actions.

- [x] Test default hidden exposure and a disabled execution error with zero network calls.
- [x] Test enabling, persistence across new registrations, immediate disabling, stale execution guards, and chat registration remaining unchanged.
- [x] Test invalid or unreadable preference files, failed preference writes, and command usage errors.
- [x] Run `npm test -- test/decision-tool.test.ts` and observe missing behavior fail.
- [x] Store only the enabled boolean in an atomic `neon-decisions.json` file under `getAgentDir()`.
- [x] Register a hidden or direct tool based on preference and re-register after commands; check the persisted preference at each execution.
- [x] Resolve current stored credentials only when enabled calls execute and return structured results with normalized input-only usage.
- [x] Register the module from `src/index.ts`; run focused tests and type checks.

## Task 4: Account for decision costs and Gemini 4

**Files:** `src/account.ts`, `src/stream.ts`, `test/account.test.ts`, `test/stream.test.ts`.

**Interfaces:** `aggregateLocalSpend` also accepts successful `neon_decide` tool result usage.
Existing stream entry points stay unchanged.

- [x] Test decision usage alongside chat usage without counting unrelated or failed tools.

```typescript
expect(result.totalCost).toBeCloseTo(0.042);
```

- [x] Test Gemini 4 catalog-driven sampling removal and signature replay with a literal fixture.
- [x] Run focused tests and confirm the new cases fail.
- [x] Extend accounting and only documented Gemini-family handling required for Gemini 4.
- [x] Run focused tests, then applicable live Gemini checks when credentials exist.

## Task 5: Document and verify

**Files:** `README.md`, `CHANGELOG.md`, `AGENTS.md`, new `test/decisions-smoke.ts`, `package.json` script only if needed.

- [x] Document the default-off command interface, persisted preference path, supported decision models, input-only billing, shared credentials, and one complete question example.
- [x] Document that disabling blocks new requests but does not cancel an in-flight request.
- [x] Add Gemini 4 to the model list and remove the outdated claim that frontier models require an access application.
- [x] Add a decision smoke entry point that calls the real request helper only when explicitly run.
- [x] Run `npm run check` and `npm test`.
- [x] Run `npm pack --dry-run` and inspect package files.
- [x] Run Gemini 4 plain/tool checks and Jev/OpenJev decision smoke checks if credentials are available.
- [x] Review `git diff --check`, ensure no secrets or version changes, and report verification limits.

## Verification results

- Node.js 22.23.4: type checks and all 389 tests pass.
- Live Jev 1.14 and OpenJev decision smoke checks pass.
- Live Gemini 4 plain and tool smoke checks pass, including requests made with pi thinking enabled.
- Gemini 4 uses default thinking because the gateway rejects reasoning_effort; no unsupported mapping is added.
- Package dry-run includes both new decision modules.
- Generated catalog matches the live upstream input and git diff --check passes.
- Socket dependency scoring is unavailable because authentication returns HTTP 401.
