import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import { execFile } from "node:child_process"

export const DUMMY_API_KEY = "wire-proxy"
export const DEFAULT_PORT = 19516

// The proxy only accepts agent names that central-cli registered, and a
// governed (workspace) session answers 403 for anything else. Each route
// therefore borrows the name of the agent that natively speaks that protocol.
export const ROUTES = {
  anthropic: { agent: "claude-code", npm: "@ai-sdk/anthropic", tail: "/anthropic/v1" },
  openai: { agent: "codex", npm: "@ai-sdk/openai", tail: "/openai/v1" },
  // The full resource form is required: the short `/v1beta1/models/...` 404s
  // upstream on a workspace session. project/location are the placeholders
  // central's own Gemini wiring uses.
  vertex: {
    agent: "gemini-cli",
    npm: "@ai-sdk/google",
    tail: "/vertex/v1beta1/projects/wire-project/locations/wire-location/publishers/google",
  },
}

// Offline fallback only: used when the proxy's model listing fails and the user
// gave no override. IDs are from the live lists observed on a workspace session.
// Every route has a live listing (see LISTING); these are the models verified to
// answer on that session, so the fallback never offers a dead entry.
export const DEFAULT_MODELS = {
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  openai: ["gpt-5.5-2026-04-23", "gpt-5.4-2026-03-05", "gpt-5.3-codex"],
  vertex: ["gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-3.5-flash"],
}

// Mirrors config.Dir() in central-cli: <home>/.jetbrains-central, unless it is
// missing/empty and the legacy <home>/.wire exists. <home> is what Go's
// os.UserHomeDir() gives: %USERPROFILE% on Windows, $HOME elsewhere. Nothing
// here is machine-specific: no absolute paths, only the current user's home.
export function userHome(env = process.env, platform = process.platform) {
  const v = platform === "win32" ? env.USERPROFILE : env.HOME
  return v || homedir()
}

function nonEmptyDir(dir) {
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

export function centralDir(env = process.env, home = userHome(env)) {
  if (env.CENTRAL_HOME) return env.CENTRAL_HOME
  const current = join(home, ".jetbrains-central")
  const legacy = join(home, ".wire")
  return !nonEmptyDir(current) && existsSync(legacy) ? legacy : current
}

export class CentralNotReadyError extends Error {}

// Reads proxy_port/proxy_secret fresh from config.json; both can change
// (port edits, secret generated on first proxy start), so never cache them.
// Like central itself, WIRE_PROXY_PORT (a positive integer) overrides proxy_port.
export async function readProxy(dir = centralDir(), env = process.env) {
  let cfg
  try {
    // Strip a UTF-8 BOM: Windows editors add one and JSON.parse rejects it.
    cfg = JSON.parse((await readFile(join(dir, "config.json"), "utf8")).replace(/^\uFEFF/, ""))
  } catch (err) {
    throw new CentralNotReadyError(`cannot read ${dir}/config.json (${err.code ?? err.message}); run \`central login\` first`)
  }
  if (!cfg.proxy_secret) {
    throw new CentralNotReadyError("proxy_secret missing in config.json; start the proxy once (`central`) to generate it")
  }
  const envPort = Number.parseInt(env.WIRE_PROXY_PORT ?? "", 10)
  const port = envPort > 0 ? envPort : cfg.proxy_port || DEFAULT_PORT
  return { port, secret: cfg.proxy_secret, aiAccess: cfg.ai_access?.type }
}

export function baseURL({ port, secret }, route) {
  const r = ROUTES[route]
  return `http://127.0.0.1:${port}/wire/${secret}/${r.agent}${r.tail}`
}

// options.models.<route> may be an array of ids or an {id: {name,...}} map.
export function modelMap(route, override) {
  const src = override ?? DEFAULT_MODELS[route]
  if (!Array.isArray(src)) return src
  return Object.fromEntries(src.map((id) => [id, { name: id, tool_call: true }]))
}

const MAX_PAGES = 10

// How each route lists its models through the proxy. Vertex has no `/models`
// under the project path; the publisher listing lives next to it. Credentials
// are the proxy's job: the dummy key below is all the proxy needs to see.
const LISTING = {
  anthropic: {
    url: (proxy) => `${baseURL(proxy, "anthropic")}/models`,
    headers: { "x-api-key": DUMMY_API_KEY, "anthropic-version": "2023-06-01" },
    params: { limit: "1000" },
    items: (b) => b.data,
    id: (m) => m.id,
    name: (m) => m.display_name,
    next: (b) => (b.has_more && b.last_id ? { after_id: b.last_id } : null),
  },
  openai: {
    url: (proxy) => `${baseURL(proxy, "openai")}/models`,
    headers: { authorization: `Bearer ${DUMMY_API_KEY}` },
    params: { limit: "1000" },
    items: (b) => b.data,
    id: (m) => m.id,
    name: (m) => m.id,
    next: (b) => (b.has_more && b.last_id ? { after_id: b.last_id } : null),
  },
  vertex: {
    url: (proxy) => `http://127.0.0.1:${proxy.port}/wire/${proxy.secret}/${ROUTES.vertex.agent}/vertex/v1beta1/publishers/google/models`,
    headers: { "x-goog-api-key": DUMMY_API_KEY },
    params: { pageSize: "1000" },
    items: (b) => b.publisherModels,
    id: (m) => m.versionId || m.name?.split("/").pop(),
    name: (m) => m.versionId || m.name?.split("/").pop(),
    next: (b) => (b.nextPageToken ? { pageToken: b.nextPageToken } : null),
  },
}

// Lists models through the proxy, which supplies the credentials; the plugin
// never reads Central's tokens. Returns [{id, name}] or null on any failure.
export async function fetchModels(proxy, route, fetchImpl = fetch) {
  const spec = LISTING[route]
  if (!spec) return null
  const out = []
  let cursor = {}
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ ...spec.params, ...cursor })
      const res = await fetchImpl(`${spec.url(proxy)}?${q}`, { headers: spec.headers, signal: AbortSignal.timeout(4000) })
      if (!res.ok) return null
      const body = await res.json()
      for (const m of spec.items(body) ?? []) {
        const id = m && spec.id(m)
        if (id) out.push({ id, name: spec.name(m) || id })
      }
      cursor = spec.next(body)
      if (!cursor) break
    }
  } catch {
    return null
  }
  return out.length ? out : null
}

// options.exclude: regex source strings; matching ids are dropped. Empty by
// default: every model the upstream lists is shown.
export function applyExclude(models, exclude = []) {
  const res = exclude.map((p) => new RegExp(p))
  return models.filter((m) => !res.some((re) => re.test(m.id)))
}

function toMap(models) {
  return Object.fromEntries(models.map((m) => [m.id, { name: m.name, tool_call: true }]))
}

// Precedence: options.models.<route> > live listing (LISTING) > static DEFAULT_MODELS.
export async function resolveModels(proxy, route, options = {}, fetchImpl = fetch) {
  const override = options.models?.[route]
  if (override) return modelMap(route, override)
  if (options.dynamic !== false) {
    const live = await fetchModels(proxy, route, fetchImpl)
    if (live) return toMap(applyExclude(live, options.exclude))
  }
  return modelMap(route, undefined)
}

export const PROVIDER_ID = "central"
export const PROVIDER_NAME = "Central"
// Provider ids of earlier versions (one provider per route); signed out on load.
export const LEGACY_PROVIDER_IDS = Object.keys(ROUTES).map((r) => `central-${r}`)

// All enabled routes' models as one flat map, since Magpie shows a single
// "Central" provider. Each entry remembers its route (it picks the SDK and URL).
// Keys are the plain model id; on a clash between routes the later one is
// namespaced `<route>/<id>` so nothing is dropped.
export async function resolveAllModels(proxy, options = {}, fetchImpl = fetch) {
  const routes = Object.keys(ROUTES).filter((r) => !options.routes || options.routes.includes(r))
  const perRoute = await Promise.all(routes.map(async (route) => [route, await resolveModels(proxy, route, options, fetchImpl)]))
  const out = {}
  for (const [route, models] of perRoute) {
    for (const [id, m] of Object.entries(models)) {
      const key = id in out ? `${route}/${id}` : id
      out[key] = { ...m, id, route }
    }
  }
  return out
}

// A model as Magpie's provider list holds it (what a `provider.models` hook must
// return): the config-style entry {name, tool_call, ...} widened to the full shape.
// `base` is the entry Magpie already has for the key (user config wins).
export function fullModel(proxy, key, m, base) {
  if (base) return base
  const none = { text: false, image: false, audio: false, video: false, pdf: false }
  return {
    id: key,
    providerID: PROVIDER_ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: baseURL(proxy, m.route), npm: ROUTES[m.route].npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.limit?.context ?? 0, output: m.limit?.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning ?? false,
      attachment: m.attachment ?? false,
      toolcall: m.tool_call ?? true,
      input: { ...none, text: true },
      output: { ...none, text: true },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

// Body of the `provider.models` hook: every route's models as Magpie wants them.
// Throws when the proxy is not ready so Magpie keeps its last list and shows why.
export async function listProviderModels(provider, options = {}, dir = centralDir(), fetchImpl = fetch) {
  const status = await centralStatus(dir, fetchImpl)
  if (!status.ready) throw new Error(status.reason)
  const given = provider?.models ?? {}
  const models = await resolveAllModels(status.proxy, options, fetchImpl)
  return Object.fromEntries(Object.entries(models).map(([key, m]) => [key, fullModel(status.proxy, key, m, given[key])]))
}

// The provider skeleton for Magpie's config: static fallback models only. The
// SDK and URL are per model (`provider`), because one provider spans three
// vendors; the provider-level npm is only a default.
export async function buildProvider(proxy, options = {}, fetchImpl = fetch) {
  const models = await resolveAllModels(proxy, options, fetchImpl)
  return {
    name: PROVIDER_NAME,
    npm: ROUTES.anthropic.npm,
    options: { apiKey: DUMMY_API_KEY },
    models: Object.fromEntries(
      Object.entries(models).map(([key, { route, id, ...m }]) => [
        key,
        { ...m, ...(key !== id && { id }), provider: { npm: ROUTES[route].npm, api: baseURL(proxy, route) } },
      ]),
    ),
  }
}

// Best-effort check for the Magpie UI: is the proxy reachable? Any HTTP
// answer (even 404) means it is listening.
export async function proxyAlive({ port }, fetchImpl = fetch) {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

// Shown wherever Magpie says the provider is not signed in.
export const NEED_CENTRAL = "需要运行登录 central-cli"

// Is there a Central CLI to talk to? It needs a readable config with a proxy
// secret (i.e. `central` was logged in and started once) and a proxy that
// answers on its port. `proxy` is only set when ready.
export async function centralStatus(dir = centralDir(), fetchImpl = fetch) {
  let proxy
  try {
    proxy = await readProxy(dir)
  } catch (err) {
    if (!(err instanceof CentralNotReadyError)) throw err
    return { ready: false, reason: err.message }
  }
  if (!(await proxyAlive(proxy, fetchImpl))) {
    return { ready: false, reason: `proxy not reachable on 127.0.0.1:${proxy.port}; start it with \`central\`` }
  }
  return { ready: true, proxy }
}

// ---- Quota (auth.usage) -------------------------------------------------
// The quota API needs Central's own bearer token, which this plugin never
// reads. `central quota --json` already does the whole job (token refresh,
// workspace and license sessions), so the plugin runs it and maps the result.

// Where to find the `central` binary, best first: CENTRAL_BIN, PATH, then the
// installer's default dir (~/.local/bin on every OS; central.exe on Windows).
export function centralBinaries(env = process.env, platform = process.platform, home = userHome(env, platform)) {
  const name = platform === "win32" ? "central.exe" : "central"
  const list = []
  if (env.CENTRAL_BIN) list.push(env.CENTRAL_BIN)
  list.push(name)
  const installed = join(home, ".local", "bin", name)
  if (existsSync(installed)) list.push(installed)
  return list
}

function execJSON(bin, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr ?? "") }))
      resolve(String(stdout))
    })
  })
}

// Runs `central quota --json` and returns the parsed object. Throws an Error
// whose message is fit to show the user.
export async function fetchQuota(env = process.env, exec = execJSON) {
  for (const bin of centralBinaries(env)) {
    let out
    try {
      out = await exec(bin, ["quota", "--json"])
    } catch (err) {
      if (err.code === "ENOENT") {
        continue
      }
      const detail = (err.stderr || err.message || "").trim().split("\n").pop()
      throw new Error(`central quota failed: ${detail}`)
    }
    try {
      return JSON.parse(out)
    } catch {
      throw new Error("central quota returned something that is not JSON; update Central CLI")
    }
  }
  throw new Error(`central CLI not found; install it or set CENTRAL_BIN to its path`)
}

const num = (v) => {
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : undefined
}

// Maps `central quota --json` to Magpie's auth.usage result. Unknown values are
// left out (Magpie reads 0 as "known, none used"). Credits are Central's unit.
export function toUsage(q) {
  const out = { plan: q.licenseName || undefined, user: q.email || undefined, windows: [] }
  if (q.managed) {
    out.windows.push({ name: "Limit", display: "Managed by your Central Server administrator", aside: true })
    return out
  }
  const used = num(q.usedDollars)
  const limit = num(q.maxDollars)
  const last = Number(q.refillLast) || 0
  const next = Number(q.refillNext) || 0
  if (used !== undefined && limit !== undefined) {
    const w = { name: "Quota", unit: "credits", amount: used, limit }
    if (limit > 0) w.used = (used / limit) * 100
    if (next > 0) w.resetsAt = next
    if (last > 0 && next > last) w.span = Math.round((next - last) / 1000)
    out.windows.push(w)
    if (next > 0) out.until = next
  }
  const top = q.topUpQuota
  const topMax = num(top?.maximum)
  if (topMax > 0) {
    // Top-up credits are an extra pool; show them without letting routing read them.
    const cur = num(top.current)
    out.windows.push({ name: "Top-up", unit: "credits", amount: cur, limit: topMax, used: cur !== undefined ? (cur / topMax) * 100 : undefined, aside: true })
  }
  return out
}

const QUOTA_TTL_MS = 30_000
let quotaCache = { at: 0, promise: null }

// Body of the `auth.usage` hook. The three providers share one account, so one
// `central quota` call (cached briefly) serves all of them. Never throws:
// Magpie shows `error` where the quota windows would be.
export async function usageFor(env = process.env, exec = execJSON, now = Date.now) {
  if (!quotaCache.promise || now() - quotaCache.at > QUOTA_TTL_MS) {
    quotaCache = { at: now(), promise: fetchQuota(env, exec).then(toUsage) }
  }
  try {
    return await quotaCache.promise
  } catch (err) {
    quotaCache = { at: 0, promise: null }
    return { error: err.message, windows: [] }
  }
}

export function resetQuotaCache() {
  quotaCache = { at: 0, promise: null }
}
