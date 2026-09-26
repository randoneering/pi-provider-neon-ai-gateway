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

You need a Neon **Launch** or **Scale** plan with prepaid credits, and a project in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, or `aws-ap-southeast-1`. Free tier can't use AI Gateway.

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

Or run `/neon-login` inside pi and paste both values. `/neon-status` shows the resolved base URL. `/neon-logout` clears it.

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
| `/neon-cap-block on` / `off` / `status` | yes | Opt-in guard that blocks turns when local spend reaches the binding limit |
| `/neon-org list` | yes | List the orgs your management key can access |
| `/neon-org use <id\|name>` | yes | Switch the active org, persist in `auth.json` |
| `/neon-models` | no | List all Neon models with input/output pricing |
| `/neon-limits` | no | Show the latest upstream rate-limit headers from 429 responses |

### `/neon-balance`

Fetches the real prepaid credit balance from `/organizations/{org_id}/billing/aigw_credits/balance` and the spending cap from `/organizations/{org_id}/billing/spending_limit`. Local spend is aggregated from the session JSONL files under `~/.pi/agent/sessions/`.

```text
Neon account balance:
  Org:           org-twilight-cake-44366159
  Spending cap:  $100.00
  Balance:       $77.77 (as of 2026-09-22 23:11 UTC)
  Local spend:   $1.62 across 45 sessions (since Sep 2026)
  Headroom:      $76.15 (binding limit − local spend, this machine only)
  Note:          Local spend ignores other machines and any Neon DB charges.
```

`Headroom` uses the smaller of the spending cap and the credit balance, minus local spend on this machine. It is a derivation, not an org-wide number.

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

By default, alerts are advisory. To stop agent turns when local spend reaches the binding limit:

```text
/neon-cap-block on
```

The setting persists in `auth.json` under `neon.capBlockEnabled`. When blocked, the message shows local spend, the binding limit, and how to disable it:

```text
Neon cap block: local spend $1.62 has reached the binding limit of $0.01 on this machine. This opt-in local-spend block prevented the agent turn. Run /neon-cap-block off to disable it.
```

Missing credentials and management API failures fail open so an API outage does not unexpectedly block the agent.

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

Pick any `neon/<model-id>`. All 34 models show up in `pi --list-models`. Run `/neon-models` to see pricing for each model.

## Models

Sourced from [neon.com/models.json](https://neon.com/models.json). The catalog and its per-model capability table are generated: run `npm run update-models` after upstream changes. The capability table (which models reject `temperature`, which support tools) drives the payload cleanup in `src/stream.ts`.

- **OpenAI**: gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-1, gpt-5-2, gpt-5-3-codex, gpt-5-4, gpt-5-4-mini, gpt-5-4-nano, gpt-5-5, gpt-5-5-pro, gpt-5-6-luna, gpt-5-6-sol, gpt-5-6-terra, gpt-6-astra, gpt-oss-120b, gpt-oss-20b
- **Google**: gemini-3-1-flash-lite, gemini-3-1-pro, gemini-3-5-flash, gemini-3-5-flash-lite, gemini-3-6-flash, gemini-3-flash, gemma-3-12b
- **Meta**: llama-4-maverick, meta-llama-3-1-8b-instruct, meta-llama-3-3-70b-instruct
- **xAI**: grok-4-6
- **Moonshot**: kimi-k3
- **Alibaba**: qwen3-next-80b-a3b-instruct, qwen35-122b-a10b
- **ZhipuAI**: glm-5-2, glm-5-3-flash
- **Thinking Machines**: inkling

GPT-5.x, Gemini 3.x, Grok, and Inkling are foundation models and need the **Apply for access** step in the Console. The rest work as soon as credits are loaded.

## Errors

The gateway speaks standard OpenAI Chat Completions. Common status codes:

| Status | What it means |
|---|---|
| 401 | Missing or invalid token |
| 403 | Token lacks `ai_gateway:invoke` scope, or branch isn't in credential lineage |
| 413 | Body exceeds 32 MiB |
| 429 | Neon per-minute TPM (200K soft cap) or upstream provider limit. Honor `Retry-After` / `X-Ratelimit-*` |
| 502 | Upstream blip, retry |

Full table: [chat completions reference](https://neon.com/docs/ai-gateway/chat-completions#error-handling).

## What the extension does

The gateway accepts OpenAI Chat Completions but rejects different params per upstream model. The extension wraps `openAICompletionsApi` and:

- Strips `$schema` markers from `tools[].function.parameters` and `response_format.json_schema.schema`
- Removes unsupported OpenAI fields (`store`, `prompt_cache_key`, `prompt_cache_retention`)
- Per-model cleanup of `frequency_penalty`, `presence_penalty`, `seed`, `stop`, `temperature`, `top_p`, `reasoning_effort`
- Translates GPT-OSS harmony `[{ type: "text" }, { type: "reasoning" }]` into flat `content` + `reasoning_content`
- Unwraps Neon's `{ error: { message } }` envelope

Beyond request handling, the extension adds local spend tracking, spending cap alerts, real AI Gateway balance lookup, rate-limit header capture, model pricing, and an opt-in turn guard. See [Commands](#commands).

## Develop

```bash
npm install
npm test               # unit tests
npm run check          # type check
npm run test:smoke     # hits a real Neon endpoint (needs NEON_AI_GATEWAY_TOKEN + NEON_AI_GATEWAY_BASE_URL)
```

## Docs

- [Overview](https://neon.com/docs/ai-gateway/overview)
- [Authentication](https://neon.com/docs/ai-gateway/authentication)
- [Model catalog](https://neon.com/docs/ai-gateway/models)
- [Chat completions](https://neon.com/docs/ai-gateway/chat-completions)
- [Troubleshooting](https://neon.com/docs/ai-gateway/troubleshooting)

## License

GPL-3.0. See [LICENSE](./LICENSE).
