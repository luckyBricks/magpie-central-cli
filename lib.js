import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"

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

// A model as Magpie's provider list holds it (what a `provider.models` hook must
// return): the config-style entry {name, tool_call, ...} widened to the full shape.
// `base` is the entry Magpie already has for the id (user config wins).
export function fullModel(route, proxy, id, m = {}, base) {
  if (base) return base
  const none = { text: false, image: false, audio: false, video: false, pdf: false }
  return {
    id,
    providerID: `central-${route}`,
    name: m.name ?? id,
    api: { id, url: baseURL(proxy, route), npm: ROUTES[route].npm },
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

// Body of the `provider.models` hook: the route's models as Magpie wants them.
// Throws when the proxy is not ready so Magpie keeps its last list and shows why.
export async function listProviderModels(route, provider, options = {}, dir = centralDir(), fetchImpl = fetch) {
  const status = await centralStatus(dir, fetchImpl)
  if (!status.ready) throw new Error(status.reason)
  const given = provider?.models ?? {}
  const models = await resolveModels(status.proxy, route, options, fetchImpl)
  return Object.fromEntries(Object.entries(models).map(([id, m]) => [id, fullModel(route, status.proxy, id, m, given[id])]))
}

export async function buildProviders(proxy, options = {}, fetchImpl = fetch) {
  const routes = Object.entries(ROUTES).filter(([route]) => !options.routes || options.routes.includes(route))
  const entries = await Promise.all(
    routes.map(async ([route, r]) => [
      `central-${route}`,
      {
        name: `Central · ${route[0].toUpperCase()}${route.slice(1)}`,
        npm: r.npm,
        api: baseURL(proxy, route),
        options: { apiKey: DUMMY_API_KEY },
        models: await resolveModels(proxy, route, options, fetchImpl),
      },
    ]),
  )
  return Object.fromEntries(entries)
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
