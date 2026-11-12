# pi-provider-neon-ai-gateway

Pi extension that registers [Neon AI Gateway](https://neon.com/docs/ai-gateway/overview) as a model provider. Published to npm and listed in the pi package gallery at [pi.dev/packages](https://pi.dev/packages).

## Install

From npm:

```bash
pi install npm:pi-provider-neon-ai-gateway
```

Or from git:

```bash
pi install git:github.com/randoneering/pi-provider-neon-ai-gateway
```

Or clone into an extensions directory:

```bash
git clone https://github.com/randoneering/pi-provider-neon-ai-gateway ~/.pi/agent/extensions/neon-ai-gateway
```

For a one-off test:

```bash
pi -e /path/to/pi-provider-neon-ai-gateway/src/index.ts
```

## Configure

You can use AI Gateway on every Neon plan, including **Free**, with prepaid credits and a project in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, or `aws-ap-southeast-1`.
An organization admin can add a payment card and buy [prepaid credits](https://neon.com/docs/ai-gateway/prepaid-credits) from **$5** under **Billing > AI gateway credits** in the Neon Console without upgrading the Free plan.
Auto-reload remains available only on paid plans.

### Mint a credential

The gateway token is a branch-scoped bearer (`nt_live_...`) with the `ai_gateway:invoke` scope. It's not your `napi_...` Neon API key. Pick one:

- `neon credentials create --scope ai_gateway:invoke` (or `neon env pull --file .env` to drop it into `.env` automatically)
- Console: Branch > **Credentials** under **Branch** > **Create credential** > check `ai_gateway:invoke`
- API: `POST /api/v2/projects/{project_id}/branches/{branch_id}/credentials` with `{"scopes": ["ai_gateway:invoke"]}`

The token is shown only once.

### Point pi at the gateway

```bash
export NEON_AI_GATEWAY_TOKEN="<token>"
export NEON_AI_GATEWAY_BASE_URL="https://br-your-branch.ai.c-2.us-east-2.aws.neon.tech"
pi
```

Or run `/neon-login` inside pi and paste both values to configure `neon`, `neon-anthropic`, and `neon-responses`.
If you logged in before all three providers were added, run `/neon-login` again, then `/reload`, to save credentials for each provider.
`/neon-status` reports each provider's configuration and the resolved base URL.
`/neon-logout` removes the stored provider credentials; shell environment variables remain unchanged.

### Management key (optional)

The gateway token alone cannot query the Neon management API. To use the balance, spending-limit, and cap-guard commands below, run `/neon-login` and paste a separate Neon management API key (`napi_...`) when prompted. The key is stored on the same `neon` entry in `auth.json` under `managementKey` and is only sent to `console.neon.tech`. Set it via the shell instead with:

```bash
export NEON_API_KEY="napi_..."
```

A read-access key is enough for viewing. Changing the spending cap requires an organization **admin** key.

## Commands

| Command | Needs key | What it does |
|---|---|---|
| `/neon-login` | no | Store the gateway token, branch URL, and optional management key |
| `/neon-status` | no | Show token, base URL, management key, and cached org id |
| `/neon-logout` | no | Clear the stored credential |
| `/neon-balance` | yes | Show the real AI Gateway credit balance, spending cap, local spend, and headroom |
| `/neon-spending-limit` | yes | Show the org spending cap |
| `/neon-spending-limit set 50` | yes, admin | Set the cap to $50.00 (dollars, up to 2 decimals) |
| `/neon-spending-limit clear` | yes, admin | Remove the cap |
| `/neon-cap-block on` / `off` / `status` | yes | Opt-in guard for the local spending cap and current credit below $2 |
| `/neon-org list` | yes | List the orgs your management key can access |
| `/neon-org use <id\|name>` | yes | Switch the active org, persist in `auth.json` |
| `/neon-models` | no | List Neon chat models with input, output, and cache-read pricing |
| `/neon-catalog preferred` / `all` / `status` | no | Choose a deduplicated or full model catalog; reload to apply changes |
| `/neon-decide enable` / `disable` / `status` | no | Control the optional Jev decision tool; gateway credentials are required for calls |
| `/neon-embed enable` / `disable` / `status` | no | Control the optional Neon embedding tool |
| `/neon-limits` | no | Show the latest upstream rate-limit headers from 429 responses |

### `/neon-balance`

Fetches the real prepaid credit balance from `/organizations/{org_id}/billing/aigw_credits/balance` and the spending cap from `/organizations/{org_id}/billing/spending_limit`. Local spend is aggregated from the session JSONL files under `~/.pi/agent/sessions/` for `neon`, `neon-anthropic`, `neon-responses`, and successful `neon_decide` and `neon_embed` tool calls.
Alerts, footer percentages, and the opt-in cap guard use that same combined local spend.

```text
Neon account balance:
  Org:           org-twilight-cake-44366159
  Spending cap:  $100.00
  Balance:       $77.77 (as of 2026-09-22 23:11 UTC)
  Local spend:   $1.62 across 45 sessions (since Sep 2026)
  Headroom:      $75.77 (conservative local estimate)
  Note:          Local spend ignores other machines and any Neon DB charges. Org-wide credit metering may be delayed.
```

`Headroom` takes the smaller known allowance: `max(0, cap - local spend)` and `max(0, current balance - $2)`.
If only one value is available, it uses that allowance; if neither is available, it omits headroom.
It shows headroom even when there are no completed local sessions.
Current prepaid balance already draws down as usage is metered, so headroom does not subtract cumulative local spend from it again.
This is a conservative local estimate, not guaranteed org-wide capacity: metering may be delayed, and concurrent requests can take the balance below $2 or negative.
See [Neon's prepaid credit rules](https://neon.com/docs/ai-gateway/prepaid-credits).

### Spending cap alerts

When a spending cap is configured, the extension warns once per session when local spend crosses 50%, 80%, and 95% of the cap. Alerts say "this machine" because the extension cannot observe usage from other machines.

### Footer status

The extension publishes a `neon-cap` status with the cap and this machine's percentage used, for example `$100.00 · 12%`.

To show it in the powerline footer, add a custom item and a layout slot in your pi config:

```nix
customItems = [
  { id = "nixos"; statusKey = "nixos"; excludeFromExtensionStatuses = true; }
  { id = "neon-cap"; statusKey = "neon-cap"; }
];

powerlineConfig.layout.left = [
  "custom:nixos"
  "model"
  "thinking"
  "shell_mode"
  "path"
  "git"
  "queue"
  "context_pct"
  "cost"
  "custom:neon-cap"
];
```

### Opt-in cap blocking

By default, alerts are advisory and blocking is off.
Enable the guard to stop agent turns when cumulative local spend reaches a known local comparison cap, or when known current prepaid balance is below $2:

```text
/neon-cap-block on
```

The setting persists in `auth.json` under `neon.capBlockEnabled`.
The cap compares only against this machine's cumulative local spend, not Neon's daily usage.
The credit check uses current balance independently of local spend; exactly $2 is allowed unless the local cap is reached.
A low-credit block tells you to add credits rather than wait for a temporary retry:

```text
Neon cap block: current prepaid balance $1.99 is below the $2.00 minimum. Add credits in the Neon Console to resume Gateway calls; a temporary retry does not replenish credits. This opt-in guard prevented the agent turn. Run /neon-cap-block off to disable it.
```

A local-cap block reports local spend and the local comparison cap instead.
The guard requires a management key and a saved org, as before.
If cap or balance lookup fails, the other known condition still applies; if neither condition can be verified, the guard fails open.
Disabling this local guard does not bypass Gateway credit or usage limits.

### Multi-org

`/neon-balance`, `/neon-spending-limit`, and the cap-alerts hook use the org persisted in `auth.json` under `neon.orgId`. To list or switch:

```text
/neon-org
/neon-org list
/neon-org use org-twilight-cake-44366159
/neon-org use My Org
```

The active org is marked with `*` in the list output. The first time you run one of these commands without a stored `orgId`, the extension auto-selects the first org returned by `/users/me/organizations` and persists it. `/neon-org use` matches case-insensitive on exact id or name.

## Use

```
/model
```

By default, each model appears once: `neon-responses` for supported OpenAI models, `neon-anthropic` for Claude, and `neon` for the remaining chat models.
Run `pi --list-models` to see available selections and `/neon-models` for chat-catalog pricing.

To show every endpoint, including duplicates, run `/neon-catalog all`, then `/reload`.
Run `/neon-catalog preferred` and `/reload` to return to the default, or `/neon-catalog status` to see the saved and active modes.
The preference persists in `neon-catalog.json` under pi's agent directory.
Existing sessions that selected a hidden endpoint may fall back to another model on resume; select the preferred model or enable `all` mode and reload to restore the old selection.
If a preferred provider is unavailable, run `/neon-login` again and `/reload` to store credentials for all three providers.

### Embeddings (opt-in)

The `neon_embed` tool generates vectors through [Neon's embeddings endpoint](https://neon.com/docs/ai-gateway/embeddings).
It defaults to disabled; run `/neon-embed enable` to expose it and `/neon-embed disable` to hide it.
The preference persists separately from gateway credentials.

Pass `input` as text or an array of up to 150 nonempty strings, and optionally set `model` to `qwen3-embedding-0-6b` (default), `bge-large-en`, or `gte-large-en`.
The tool returns complete vectors and input-token usage; large batches can consume substantial context.
Neon bills each request, and recorded embedding usage contributes to local spending totals, alerts, and the opt-in cap guard.
`bge-large-en` silently drops input after 512 tokens, so split longer text before embedding.

### Decision models (opt-in)

The `neon_decide` tool uses [Neon's decision endpoint](https://neon.com/docs/ai-gateway/decisions) to classify, route, or score text, JSON, and images.
It defaults to **disabled**, so it does not compete with another decision tool such as `pi-jev`.

```text
/neon-decide enable
/neon-decide status
/neon-decide disable
```

Changes take effect immediately and persist in `neon-decisions.json` under pi's agent directory, normally `~/.pi/agent/`.
Disabling hides the tool and blocks new calls, including calls from stale declarations.
It does not cancel a request that already started, change your chat model, or disable tools from other packages.
The preference stays separate from gateway credentials and survives `/neon-logout`.

Enable the tool, then ask pi to call `neon_decide` with arguments such as:

```json
{
  "state": "I was charged twice. Please refund the duplicate payment.",
  "questions": {
    "refund": { "type": "noul", "instructions": "Is a refund requested?" },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "billing": "Payments and refunds", "support": "Other requests" }
    },
    "severity": {
      "type": "score",
      "instructions": "How serious is the issue?",
      "criteria": ["Cosmetic", "Incorrect charge", "Cannot access service"]
    }
  }
}
```

`state` accepts text or a JSON object.
Each question returns a probability (`noul`), an option with probabilities (`choice`), or a numeric level with probabilities (`score`).
Choice and score questions need at least two options or levels.

For images, map an asset ID to a local PNG or JPEG path in `images`.
Put the same ID in `state` and refer to that state field in the question instructions:

```json
{
  "state": { "photo": "img-1" },
  "images": { "img-1": "./package.png" },
  "questions": { "damaged": { "type": "noul", "instructions": "Is the package in `photo` damaged?" } }
}
```

Relative paths resolve from the session working directory.
The tool reads and sends file contents to Neon; images count as billed input tokens.
Image files must total at most 24 MiB and the complete request must fit within 32 MiB.
Jev 1.14 requires images at least 280 × 280 pixels; OpenJev accepts smaller images.

| Model | Selection | Input price per million tokens |
|---|---|---|
| Jev 1.14 | Default, or `"model": "typesafeai-jev-1-14-0"` | $0.042 |
| OpenJev (Qwen 3.5 4B) | `"model": "openjev-qwen35-4b"` | $0.042 |

Calls reuse `/neon-login` credentials or `NEON_AI_GATEWAY_TOKEN` and `NEON_AI_GATEWAY_BASE_URL`.
The tool sends supplied state, questions, and any images to `/typesafe/v1/systemone`, bills input tokens only, and reports usage in pi and local Neon spending totals.
Requests support cancellation, time out after 30 seconds, and do not retry automatically.
Decision models do not support chat or streaming and do not appear in the `/model` picker.

## Models

Sourced from [neon.com/models.json](https://neon.com/models.json). The catalog and its per-model capability table are generated: run `npm run update-models` after upstream changes. The capability table (which models reject `temperature`, which support tools) drives the payload cleanup in `src/stream.ts`.
Generated model costs include published context-length tiers, so pi uses the higher rate when input tokens, including cache tokens, exceed the model's threshold.
These remain estimates: missing cache rates fall back to the base rate, and GPT-5.5 Pro uses its input rate for cache reads because OpenAI publishes no cache discount.

The `neon` provider uses Chat Completions; `neon-anthropic` uses native Anthropic Messages; `neon-responses` uses the OpenAI Responses API at `/openai/v1/responses`.
`gpt-5-3-codex` and `gpt-5-5-pro` require the Responses endpoint, so they are exposed only on `neon-responses` ([Neon endpoint guidance](https://neon.com/docs/ai-gateway/models#which-endpoint-to-use)).
`neon-responses` also exposes GPT-5, GPT-5 Mini and Nano, GPT-5.1, GPT-5.2, GPT-5.4 and its Mini and Nano variants, GPT-5.5, and GPT-5.6 Luna, Sol, and Terra.
These shared models remain available on chat completions in `/neon-catalog all` mode.
`gpt-6-1-sol` and `gpt-6-astra` also live on `neon-responses`: their chat upstream rejects function tools with every reasoning effort, including `none`, so tool use needs the Responses endpoint. Their chat entries stay for text-only use in `all` mode.

- **Anthropic**: claude-fable-5, claude-fable-5-1, claude-haiku-4-5, claude-haiku-5-5, claude-opus-4-1, claude-opus-4-5, claude-opus-4-6, claude-opus-4-7, claude-opus-4-8, claude-opus-5, claude-opus-5-5, claude-sonnet-4-5, claude-sonnet-4-6, claude-sonnet-5, claude-sonnet-5-5
- **OpenAI**: gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-1, gpt-5-2, gpt-5-4, gpt-5-4-mini, gpt-5-4-nano, gpt-5-5, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra, gpt-6-1-sol, gpt-6-astra, gpt-6-luna, gpt-6-sol, gpt-oss-120b, gpt-oss-20b; plus `gpt-5-3-codex` and `gpt-5-5-pro` on `neon-responses`
- **Google**: gemini-3-1-flash-lite, gemini-3-1-pro, gemini-3-5-flash, gemini-3-5-flash-lite, gemini-3-6-flash, gemini-3-7-flash, gemini-3-8-flash, gemini-3-flash, gemini-4-argon, gemma-3-12b
- **Meta**: llama-4-maverick, meta-llama-3-1-8b-instruct, meta-llama-3-3-70b-instruct
- **xAI**: grok-4-6, grok-4-7
- **DeepSeek**: deepseek-v4-1-flash
- **Moonshot**: kimi-k3, kimi-k3-1-pro
- **Alibaba**: qwen3-next-80b-a3b-instruct, qwen35-122b-a10b
- **ZhipuAI**: glm-5-2, glm-5-3, glm-5-3-flash
- **TypeSafe decisions**: Jev 1.14 and OpenJev through the optional `neon_decide` tool, separate from chat

Claude models use native Anthropic Messages on `neon-anthropic`; chat completions on `neon` are available in `all` mode.
OpenAI Responses models use `neon-responses`; TypeSafe decision models use `neon_decide`.
This list is a snapshot; the generated catalog is the source of truth, so check `/neon-models` or `pi --list-models` for the current set.

All catalog models are available on every Neon plan, including Free, with prepaid credits; a separate access request is no longer required.

### Model compatibility

Gemini 3 streaming omits the rejected `stream_options` field.
Gemini 3 and 4 tool calls keep their opaque [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures) through saved history and replay, and a final `stop` becomes `tool_calls` only when that choice emitted tools.
Normal text stops and truncation stay unchanged.
Gemini 4 Argon uses its default thinking behavior: the chat gateway rejects `reasoning_effort`, so the extension omits it.
Pi's thinking selection does not control Gemini 4 reasoning depth on this endpoint.

Newer Claude models on `neon-anthropic` use these native thinking modes:

| Models | Thinking off | Thinking on |
|---|---|---|
| Opus 5.5, Fable 5/5.1 | Adaptive, low effort; off is unavailable | Adaptive, requested effort |
| Sonnet 5.5 | `between_tools` | Adaptive, requested effort |
| Opus 4.7/4.8/5, Sonnet 5, Haiku 5.5 | Disabled | Adaptive, requested effort |

Other Claude models keep the pinned SDK's existing thinking behavior.
See [Neon's native thinking reference](https://neon.com/docs/ai-gateway/anthropic-messages#extended-thinking).

On chat completions, these models accept function tools only with `reasoning_effort: "none"`: gpt-5-4, gpt-5-4-mini, gpt-5-4-nano, gpt-5-5, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra, gpt-6-luna, and gpt-6-sol.
The extension sets `none` automatically when tools are present; reasoning without tools keeps the requested effort.
Function tools cannot work on chat for `gpt-6-1-sol` and `gpt-6-astra` (they reject `none` too); use `neon-responses` for tool-driven work with those models.
GPT-OSS, Llama, Qwen, and Gemma models get `max_completion_tokens` renamed to `max_tokens`, which their upstream requires.
Gemini 3/4, `gemma-3-12b`, and `qwen35-122b-a10b` receive `system` in place of pi's `developer` message role.

## Errors

The gateway speaks standard OpenAI Chat Completions. Common status codes:

| Status | What it means |
|---|---|
| 400 | Bad request. Notable: OpenAI models reject requests with more than 128 tools (`Invalid 'tools': array too long`) |
| 401 | Missing or invalid token |
| 403 | Token lacks `ai_gateway:invoke` scope, or branch isn't in credential lineage |
| 413 | Body exceeds 32 MiB |
| 429 | Short-window rate limit, daily spend cap, or prepaid balance below $2. Check the cause before retrying |
| 502 | Upstream blip, retry |

For 429 responses, [Neon's prepaid credit docs](https://neon.com/docs/ai-gateway/prepaid-credits#usage-limits) distinguish:

- **Short-window limits:** honor `Retry-After`, which points to the next minute.
  Any `x-ratelimit-*` headers come from the upstream provider, not Neon's limits.
- **Daily spend cap:** defaults to $20 per day and may vary by account.
  A short-window retry does not reset it; wait for the daily allowance or request a limit increase.
- **Depleted credit:** new calls return 429 while current balance is below $2.
  Add credits in the Neon Console; retrying alone does not replenish them.

The default token limit is 200,000 TPM for input and output separately, and may vary by account.
Balance draws down as usage is metered and can go negative with concurrent requests.
These are Gateway limits, separate from the opt-in cumulative local-spend guard.
This extension does not add automatic retries for these conditions.

Full table: [chat completions reference](https://neon.com/docs/ai-gateway/chat-completions#error-handling).

### Tool limit (128) on OpenAI models

OpenAI models through the gateway accept at most 128 tools per request; the upstream rejects anything more with a 400 `Invalid 'tools': array too long` error (live-verified on `gpt-6-luna` at 129 tools; Gemini, Claude, Kimi, and GLM accept more). A pi session with many extensions and MCP servers can cross this limit, and subagent sessions inherit the full toolset. When it happens, the extension appends the remedy to the error: disable MCP servers or unused tools, or switch to a non-OpenAI model. Pi's `--exclude-tools` and `pi config` (disable an extension or MCP server) reduce the tool count.

## What the extension does

The gateway accepts OpenAI Chat Completions but rejects different params per upstream model. The extension wraps `openAICompletionsApi` and:

- Strips `$schema` markers from `tools[].function.parameters` and `response_format.json_schema.schema`
- Removes unsupported OpenAI fields (`store`, `prompt_cache_key`, `prompt_cache_retention`)
- Per-model cleanup of `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `temperature`, `top_p`, `reasoning_effort`
- Enriches the upstream 128-tool rejection with its remedy, and 429 account-quota errors with `Retry-After`
- Translates GPT-OSS harmony `[{ type: "text" }, { type: "reasoning" }]` into flat `content` + `reasoning_content`
- Unwraps Neon's `{ error: { message } }` envelope

Beyond request handling, the extension adds local spend tracking, spending cap alerts, real AI Gateway balance lookup, rate-limit header capture, model pricing, and an opt-in turn guard. See [Commands](#commands).

## Develop

```bash
npm ci
npm test               # unit tests
npm run check          # type check
npm run test:smoke     # hits a real Neon endpoint (needs NEON_AI_GATEWAY_TOKEN + NEON_AI_GATEWAY_BASE_URL)
```

Smoke tests use the extension's adapters and bill real gateway usage.
Choose a provider explicitly to compare the same Claude model on both endpoints:

```bash
npm run test:smoke -- claude-sonnet-4-6 --provider neon
npm run test:smoke -- claude-sonnet-4-6 --provider neon-anthropic --tools
npm run test:smoke -- gpt-5-5-pro --provider neon-responses --tools --thinking
npm run test:smoke -- gpt-6-luna --provider neon --tools --thinking
npm run test:smoke -- gemini-3-8-flash --provider neon --tools
npm run test:smoke -- gemini-4-argon --provider neon --tools
npm run test:smoke -- claude-sonnet-5-5 --provider neon-anthropic --tools --thinking
```

Without `--provider`, Claude models use `neon-anthropic`, the two Responses-only models use `neon-responses`, and everything else uses `neon`.
`--tools` checks one local echo-tool call and its follow-up reply, with at most two requests.
The check fails on gateway errors, missing or unexpected tool calls, truncated responses, or a reply other than `smoke test ok`.
Luna chat-completions tool calls use `reasoning_effort: "none"`, even with `--thinking`, because the gateway requires it.

Decision smoke tests use the same request helper as the tool and accept environment or stored Neon credentials:

```bash
npm run test:smoke:decisions -- typesafeai-jev-1-14-0
npm run test:smoke:decisions -- openjev-qwen35-4b
```

These explicit smoke commands make paid requests even when the agent-facing decision tool is disabled.

## Docs

- [Overview](https://neon.com/docs/ai-gateway/overview)
- [Authentication](https://neon.com/docs/ai-gateway/authentication)
- [Model catalog](https://neon.com/docs/ai-gateway/models)
- [Chat completions](https://neon.com/docs/ai-gateway/chat-completions)
- [Decisions](https://neon.com/docs/ai-gateway/decisions)
- [Troubleshooting](https://neon.com/docs/ai-gateway/troubleshooting)

## License

GPL-3.0. See [LICENSE](./LICENSE).
