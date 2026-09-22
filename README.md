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

### Optional: enable `/neon-balance`

The gateway token alone cannot query the Neon management API. To see the org spending cap and your local cumulative Neon spend, run `/neon-login` and paste a separate Neon management API key (`napi_...`) when prompted. The key is stored on the same `neon` entry in `auth.json` under `managementKey` and is only sent to `console.neon.tech`. Set it via the shell instead with:

```bash
export NEON_API_KEY="napi_..."
```

`/neon-balance` then resolves your org from `/users/me/organizations`, caches the org id back into `auth.json`, and fetches `/organizations/{org_id}/billing/spending_limit`. Local spend is aggregated from the session JSONL files under `~/.pi/agent/sessions/`.

The output looks like:

```
Neon account balance:
  Org:            My Org (org-...)
  Spending cap:   $50.00
  Local spend:    $0.23 across 14 sessions (since Sep 2026)
  Headroom:       $49.77 (cap − local spend, this machine only)
  Balance:        Not exposed by the Neon API. Visible in the Neon Console.
  Note:           Local spend ignores other machines and any Neon DB charges.
```

The actual prepaid credit balance is not exposed by the Neon management API. `Headroom` is a derivation (cap minus this machine's spend), not a real balance, and undercounts anything spent elsewhere or charged for Neon database usage.

## Use

```
/model
```

Pick any `neon/<model-id>`. All 34 models show up in `pi --list-models`.

## Models

Sourced from [neon.com/models.json](https://neon.com/models.json). Update `src/models.ts` when upstream adds models.

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
