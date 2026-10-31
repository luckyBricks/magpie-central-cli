# magpie-central-cli — Spec

A Magpie plugin that exposes the models served by a **locally running JetBrains
Central CLI proxy** (`central`) as three Magpie providers: Anthropic, OpenAI and
Vertex. The plugin holds no JetBrains credentials; the proxy injects them.

## Goals / non-goals

- Goal: reuse the user's existing `central login` session from inside Magpie.
- Goal: zero config when the proxy runs on this machine.
- Non-goal: logging in, starting or stopping the proxy, refreshing tokens.
- Non-goal (v0.1): Bedrock and Ingrazzio routes.

## How it works

Magpie provider → `http://127.0.0.1:{port}/wire/{secret}/{agent}/{route}/…` →
central proxy (adds auth, forwards to JetBrains AI Platform).

| Provider id | `npm` (AI SDK) | Base URL tail | Borrowed `{agent}` | SDK appends |
|---|---|---|---|---|
| `central-anthropic` | `@ai-sdk/anthropic` | `/anthropic/v1` | `claude-code` | `/messages` |
| `central-openai` | `@ai-sdk/openai` | `/openai/v1` | `codex` | `/responses` |
| `central-vertex` | `@ai-sdk/google` | `/vertex/v1beta1/projects/wire-project/locations/wire-location/publishers/google` | `gemini-cli` | `/models/<m>:streamGenerateContent` |

`apiKey` is the dummy `wire-proxy` (the proxy strips and replaces it).

## Design decisions and constraints

1. **Port and secret are read from `~/.jetbrains-central/config.json`**
   (`proxy_port`, default 19516; `proxy_secret`), on every plugin start, never
   hardcoded or cached across runs. The secret is generated on first proxy start;
   if missing, the plugin logs an actionable message and registers nothing.
   The data dir follows central-cli's `config.Dir()`: `~/.jetbrains-central`, or
   legacy `~/.wire` when the former is missing/empty. `CENTRAL_HOME` overrides it
   (tests, sandboxes).
   Restart the plugin host (toggle the plugin) after the port/secret changes.

2. **Agent name must be a registered central agent.** In
   `internal/proxy/handler.go` an unknown agent gets `403 unknown agent blocked by
   AI governance` on workspace (governed) sessions, and `400` for non-default
   routes even on license sessions. So each route borrows the name of the agent
   that natively speaks that protocol (table above). Consequences: proxy logs and
   analytics attribute traffic to those agents, and the org's allow-list must
   permit them. The clean fix is registering a `magpie` agent in central-cli
   (out of scope here).

3. **Models are listed dynamically on every route, with a static fallback.** Each
   route is its own plugin with a `provider.models` hook (Magpie's per-provider
   model list hook), asked on every listing/refresh. It lists the models **through
   the proxy**, which supplies the credentials (4 s timeout, paginated), reading
   port/secret fresh each time. The `config` hook only registers the provider
   skeleton with the static fallback models (no network at load). If the proxy is
   not ready the hook throws, so Magpie keeps its last list and shows the reason:

   | Route | Listing request (via proxy) | Response |
   |---|---|---|
   | `anthropic` | `GET …/anthropic/v1/models?limit=1000` | `data[].id`, `display_name`; `has_more`/`last_id` |
   | `openai` | `GET …/openai/v1/models?limit=1000` | `data[].id` |
   | `vertex` | `GET …/vertex/v1beta1/publishers/google/models?pageSize=1000` | `publisherModels[].versionId`; `nextPageToken` |

   Note the Vertex listing is **not** under the `projects/…/locations/…` path
   (that returns 404); the publisher listing sits beside it.

   Precedence per route: `options.models.<route>` > live list > static
   `DEFAULT_MODELS` (the fallback holds only models verified to answer).
   - **The plugin never reads Central's tokens.** `tokens.enc` is AES-256-GCM
     encrypted with a key in the OS keychain (`wire-jbai`/`encryption-key`);
     decrypting it would bypass the proxy and its governance, and is not needed:
     the proxy injects the right bearer for every request, listings included.
   - **Everything the upstream lists is shown by default** — preview/EAP models
     (`*-eap`), non-chat models (`text-embedding-*`) and Vertex `*-early-exp*`
     entries (listed but 404 on `generateContent`) included. Users can hide some
     with `options.exclude` (regex sources); nothing is hidden otherwise.
   - The list is refreshed whenever Magpie refreshes the provider's models; no
     plugin toggle is needed. Entries Magpie already holds for an id (user config)
     are kept as-is.
   - `provisioning.json` is deliberately **not** used: its `models` arrays are
     empty for non-Bedrock agents, hold Bedrock IDs otherwise, are absent on
     license sessions, and the file also contains MCP secrets.
   - The proxy does not validate model IDs; an ID the upstream rejects fails at
     request time.

4. **Governance applies.** Workspace sessions enforce the org allow-list
   (agents, and Bedrock models only). License sessions are unrestricted.

5. **Security.** Anyone holding `proxy_secret` can spend the user's AI quota via
   loopback. Never log or transmit the secret (only the base URL structure).
   Magpie plugins run with host permissions; request bodies contain conversation
   content and must not be logged.

6. **Provider ids** are `central-*` to avoid colliding with built-in providers
   (Magpie renames collisions to `<id>-plugin`). Config uses `??=` so user config
   wins.

7. **Vertex needs the full resource path.** `…/vertex/v1beta1/models/<m>:…`
   (short form) 404s upstream on a workspace session; the form with
   `projects/wire-project/locations/wire-location/publishers/google` returns
   200. Hence the long base URL above.

8. **Providers are discovered through `auth` hooks, not `config`.** Magpie lists
   a plugin's providers from `hooks.auth.provider`; a `config`-only plugin loads
   but `magpie providers` stays empty. Each route is therefore its own exported
   plugin function (Magpie loads every exported function; a default
   `{id, server}` allows just one) with an `auth` hook, and the plugin calls
   `client.auth.set` with the dummy key `wire-proxy` at load so the provider is
   already "signed in" and the user never logs in.

9. **Magpie exposes only the models the user picked.** The plugin hands Magpie
   every listed model, but `magpie providers` shows "N exposed of M" (e.g.
   "1 exposed of 12"): the rest are "not picked" and a new model stays off until
   it is ticked (UI) or exposed with
   `magpie provider models <id> +<model>`. This is Magpie's own selection, not a
   plugin filter; `magpie provider models <id>` lists what is and is not shown.

10. **Module exports.** Magpie treats every exported *function* as a plugin, so
   helpers live in `lib.js` and are exposed only as the `_internal` object.

11. **Quota via `central quota --json`, not the quota API.** The quota API
   takes Central's own bearer token (and needs refresh handling for workspace
   and license sessions), which the plugin must not read (see 3). So each
   provider's `auth.usage` hook runs the `central` binary (`CENTRAL_BIN`, `PATH`,
   `~/.local/bin`) and maps its JSON to Magpie's usage result (docs:
   usemagpie.ai/docs/zh/plugins#usage):

   | Central field | Magpie window field |
   |---|---|
   | `usedDollars` / `maxDollars` (credits, despite the name) | `amount` / `limit`, `unit: "credits"`, `used` = percent |
   | `refillNext` (ms) | `resetsAt`, and top-level `until` |
   | `refillNext - refillLast` | `span` (seconds) |
   | `licenseName`, `email` | `plan`, `user` |
   | `topUpQuota` (when maximum > 0) | extra `Top-up` window, `aside: true` |
   | `managed: true` | one `aside` window with text only, no numbers |

   Unknown values are omitted, never sent as 0 (Magpie reads 0 as "none used").
   The hook never throws: failures come back as `{error, windows: []}`. The three
   providers share one cached (30 s) call. The cost is a runtime dependency on
   the `central` binary being installed, which the proxy dependency already implies.
   `resetsAt` is sent in milliseconds; the docs do not say whether seconds or
   milliseconds are expected there (they accept both for `until`).

## Plugin options

```jsonc
{
  "routes": ["anthropic", "openai", "vertex"],   // subset to enable
  "dynamic": true,                                // false: skip the live listing, use static lists
  "exclude": ["-eap$", "^text-embedding"],        // regexes of model ids to hide (default: none)
  "models": {                                     // per-route override; wins over everything
    "anthropic": ["claude-sonnet-5-5"],           // ids, or {id: {name, limit, ...}}
    "vertex": { "gemini-3.5-flash": { "name": "Gemini 3.5 Flash" } }
  }
}
```

## Verified vs. unverified

- Verified in real Magpie (CLI, `magpie provider test`): `central-anthropic` ✓,
  `central-openai` ✓. `central-vertex` fails the built-in probe (Magpie POSTs to
  the base URL for `@ai-sdk/google`, a Code Assist style check → 404), but a
  hand-made Gemini request through the proxy succeeds (see below); chatting from
  the Magpie UI is still to be confirmed.
- Verified (workspace session, local proxy): Anthropic `/messages` → 200; OpenAI
  `/responses` → 200; unknown agent → 403; live listing → 17 Anthropic, 38 OpenAI
  and 12 Vertex models (via `buildProviders`). Of the 12 Vertex models, 9 answer
  `generateContent` (200); the 3 `*-early-exp*` ones return 404. Unit tests
  (`bun test`) cover pagination, fallback, exclude, overrides, Vertex listing and
  the data-dir fallback.
- Verified Vertex: `generateContent` and `streamGenerateContent` on the full path
  with `x-goog-api-key: wire-proxy` → 200 for `gemini-3-flash-preview`.
- Not verified: an actual chat in the Magpie UI through each provider (esp. that
  `@ai-sdk/google` builds the full-path URL); `/models` on license and Central
  Server (IDES) sessions.
- Resolved: Magpie does need an `auth` hook to list a provider (see 8).

## Roadmap

- Find a way to make Magpie's built-in Vertex probe pass (or confirm it is harmless).
- Declare `auth.options` switches (Magpie 0.1.2411+) for what is now `options.exclude`.
- Bedrock route (`/bedrock/model/{id}/{op}`), once central exposes it for this agent.
- Replace borrowed agent names with a registered `magpie` agent in central-cli.
