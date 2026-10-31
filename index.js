import { DUMMY_API_KEY, LEGACY_PROVIDER_IDS, NEED_CENTRAL, PROVIDER_ID, buildProvider } from "./lib.js"
import * as lib from "./lib.js"
import { ICON } from "./icons.js"

// Magpie finds a provider through an `auth` hook naming it, and it loads every
// exported function as a plugin. One plugin, one provider: "Central", spanning
// the Anthropic, OpenAI and Vertex routes (each model carries its own SDK/URL).
// There is no default export: `{id, server}` would allow only one plugin per
// module. `_internal` is an object without `server`, so Magpie skips it.
export const _internal = { ...lib }

export const central = async (input, options = {}) => {
  // Earlier versions registered one provider per route; drop their stand-in
  // sign-ins so only "Central" is left.
  for (const id of LEGACY_PROVIDER_IDS) await input.client?.auth?.remove?.({ path: { id } })

  const status = await lib.centralStatus()
  if (!status.ready) {
    console.error(`[central-cli] ${status.reason}`)
    // Drop the stand-in sign-in so Magpie shows the provider as signed out,
    // and say what to do right there. Signing in re-checks, so it works
    // as soon as `central` is running, without toggling the plugin.
    await input.client?.auth?.remove?.({ path: { id: PROVIDER_ID } })
    return {
      auth: {
        provider: PROVIDER_ID,
        icon: ICON,
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
  await input.client?.auth?.set({ path: { id: PROVIDER_ID }, body: { type: "api", key: DUMMY_API_KEY } })

  return {
    auth: {
      provider: PROVIDER_ID,
      icon: ICON,
      // Never prompted for in practice: the sign-in above is automatic.
      methods: [{ type: "api", label: "Local Central CLI proxy (no key needed)" }],
      // No baseURL here: it differs per route and lives on each model's `api`.
      loader: async () => ({ apiKey: DUMMY_API_KEY }),
      // Central's own allowance (credits used / limit, refill period). Magpie
      // calls usage(getAuth, provider); neither is needed since the quota belongs
      // to the Central login, not a key.
      usage: () => lib.usageFor(),
    },
    // The skeleton only (static fallback models, no network): the live list
    // comes from the `provider.models` hook below.
    config: async (cfg) => {
      const provider = await buildProvider(proxy, { ...options, dynamic: false })
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= provider
    },
    // Asked on every listing/refresh, so the list is live and follows the
    // proxy's current port and secret without toggling the plugin.
    provider: {
      id: PROVIDER_ID,
      models: (provider) => lib.listProviderModels(provider, options),
    },
  }
}
