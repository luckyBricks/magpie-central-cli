import { DUMMY_API_KEY, NEED_CENTRAL, buildProviders, readProxy } from "./lib.js"
import * as lib from "./lib.js"
import { ICONS } from "./icons.js"

// Magpie finds a provider through an `auth` hook naming it, and it loads every
// exported function as a plugin, so each route is one exported plugin. There is
// no default export: `{id, server}` would allow only one plugin per module.
// `_internal` is an object without `server`, so Magpie skips it.
export const _internal = { ...lib }

function make(route) {
  const id = `central-${route}`
  return async (input, options = {}) => {
    const status = await lib.centralStatus()
    if (!status.ready) {
      console.error(`[central-cli] ${status.reason}`)
      // Drop the stand-in sign-in so Magpie shows the provider as signed out,
      // and say what to do right there. Signing in re-checks, so it works
      // as soon as `central` is running, without toggling the plugin.
      await input.client?.auth?.remove?.({ path: { id } })
      return {
        auth: {
          provider: id,
          icon: ICONS[route],
          methods: [
            {
              type: "api",
              label: NEED_CENTRAL,
              keyless: true,
              authorize: async () => {
                const now = await lib.centralStatus()
                return now.ready ? { type: "success", key: DUMMY_API_KEY } : { type: "failed", error: NEED_CENTRAL }
              },
            },
          ],
          loader: async () => ({}),
        },
      }
    }
    const proxy = status.proxy
    // The proxy holds the real credentials; Magpie only needs some account to
    // exist, so keep the dummy key signed in and the user never logs in.
    await input.client?.auth?.set({ path: { id }, body: { type: "api", key: DUMMY_API_KEY } })

    return {
      auth: {
        provider: id,
        icon: ICONS[route],
        // Never prompted for in practice: the sign-in above is automatic.
        methods: [{ type: "api", label: "Local Central CLI proxy (no key needed)" }],
        loader: async () => ({ apiKey: DUMMY_API_KEY, baseURL: lib.baseURL(await readProxy(), route) }),
        // Central's own allowance (credits used / limit, refill period), the same
        // for all three providers. Magpie calls usage(getAuth, provider); neither
        // is needed since the quota belongs to the Central login, not a key.
        usage: () => lib.usageFor(),
      },
      // The skeleton only (static fallback models, no network): the live list
      // comes from the `provider.models` hook below.
      config: async (cfg) => {
        const providers = await buildProviders(proxy, { ...options, routes: [route], dynamic: false })
        cfg.provider ??= {}
        for (const [pid, p] of Object.entries(providers)) cfg.provider[pid] ??= p
      },
      // Asked on every listing/refresh, so the list is live and follows the
      // proxy's current port and secret without toggling the plugin.
      provider: {
        id,
        models: (provider) => lib.listProviderModels(route, provider, options),
      },
    }
  }
}

export const centralAnthropic = make("anthropic")
export const centralOpenai = make("openai")
export const centralVertex = make("vertex")
