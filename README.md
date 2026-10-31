# magpie-central-cli

Use the models behind a local JetBrains Central CLI proxy in Magpie
(one provider, **Central**, serving the Anthropic, OpenAI and Vertex (Gemini) models of your Central login).

The plugin is plain ES modules with **no dependencies and no build step**, and
contains no absolute paths, usernames or credentials. It works on macOS, Linux
and Windows from wherever you unpack it.

## Prerequisites (on the machine that runs Magpie)

1. [Central CLI](https://github.com/JetBrains/central-cli) installed, `central login` done, and the proxy running
   (run `central`, start the proxy; `central status` to check).
2. Magpie. Bun is only needed to run the unit tests, not to use the plugin.

The plugin finds Central by itself on every start; nothing to configure:

| What | Where it looks |
|---|---|
| Data dir | `%USERPROFILE%\.jetbrains-central` (Windows) / `~/.jetbrains-central` (macOS, Linux); legacy `.wire` if the former is missing or empty. `CENTRAL_HOME` overrides. |
| Port | `proxy_port` in `config.json` (default 19516); the `WIRE_PROXY_PORT` env var overrides it, as it does for `central`. |
| Secret | `proxy_secret` in `config.json` (created when the proxy first starts). |

If Central is not logged in or the proxy is not running, the providers show as
signed out with the hint "需要运行登录 central-cli"; start it and sign in again, no
need to toggle the plugin. The proxy secret never leaves the machine, so the
plugin folder is safe to copy anywhere; **do not** copy `~/.jetbrains-central`.

## Quota

The Central provider reports your allowance to Magpie through its `auth.usage`
hook: credits used / limit, percent, and when the period refills (shown on the
provider's account card, in `magpie quota` and `GET /v1/magpie/quotas`). It
belongs to your Central login, not to an API key, and is the data behind
`central quota`.

The plugin gets it by running `central quota --json`, so the **`central` binary
must be on the machine**. It is looked up in `CENTRAL_BIN`, then `PATH`, then
`~/.local/bin` (`%USERPROFILE%\.local\bin\central.exe` on Windows), which is
where the installer puts it. The plugin never reads Central's tokens. If the
binary is missing or the login expired, the card shows the reason instead of
numbers (e.g. "central CLI not found; install it or set CENTRAL_BIN").
Workspace-managed limits you cannot query show "Managed by your Central Server
administrator". Results are cached for 30 s.

## Upgrading from 0.3 or older

Earlier versions showed three providers (`central-anthropic`, `central-openai`,
`central-vertex`). They are now one provider, `central`. The old providers'
sign-ins are removed automatically on load, but models you picked under them
are not carried over: pick them again under Central.

## Install / update from GitHub

The source lives at <https://github.com/LuckyBricks/magpie-central-cli>. You can
install and update the plugin straight from there, no package build needed:

```sh
git clone https://github.com/LuckyBricks/magpie-central-cli.git
magpie plugin add ./magpie-central-cli
```

To update later, pull the latest version and restart Magpie:

```sh
git -C magpie-central-cli pull
```

## Install on another computer

Build the package once (any OS with npm):

```sh
npm run pack     # → dist/magpie-central-cli-<version>.tgz (creates dist/ first)
```

Move the `.tgz` to the target machine and unpack it into any folder. The
archive contains a `package/` directory, which is the plugin.

macOS / Linux:

```sh
mkdir magpie-central-cli && tar -xzf magpie-central-cli-0.4.1.tgz -C magpie-central-cli
magpie plugin add ./magpie-central-cli/package
```

Windows (PowerShell; `tar` ships with Windows 10 1803+):

```powershell
mkdir magpie-central-cli; tar -xzf magpie-central-cli-0.4.1.tgz -C magpie-central-cli
magpie plugin add .\magpie-central-cli\package
```

Use an absolute path if you plan to move the shell elsewhere. On macOS the
binary may be `/Applications/magpie.app/Contents/MacOS/magpie` when `magpie` is
not on `PATH`; on Windows use the full path to `magpie.exe` the same way.
Prefer a folder without spaces if your Magpie build complains about the path.

Then check:

```sh
magpie plugin --json                  # load errors, if any
magpie provider test central          # the built-in probe may 404 for the Gemini models; chat in Magpie instead
```

Models of all three vendors are listed live through the proxy into the one Central list (each model keeps its own SDK and URL; an id served by two vendors shows the later one as `<route>/<id>`). The plugin hides
nothing; Magpie only shows the ones you pick: `magpie provider models central`
lists them, `+<model>` exposes one. The list refreshes with Magpie's own model
refresh. Options:

```sh
magpie plugin options central-cli '{"exclude":["-eap$"],"models":{"vertex":["gemini-3.5-flash"]}}'
```

On PowerShell quote the JSON as `'{\"exclude\":[\"-eap$\"]}'` (or use a here-string).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Quota card says "central CLI not found" | Install Central CLI, or set `CENTRAL_BIN` to the full path of `central` (`central.exe` on Windows) in the environment that starts Magpie. |
| Quota card says "token expired" | Run `central login`. |
| Providers show "需要运行登录 central-cli" | `central login`, start the proxy, then sign in again. `central status` should show it running. |
| `cannot read …config.json` in the Magpie log | Central never ran on this user account, or `CENTRAL_HOME`/`HOME`/`USERPROFILE` differ between the shell that started Central and the one that started Magpie. |
| `proxy not reachable on 127.0.0.1:<port>` | Proxy stopped, or Central uses another port: set `WIRE_PROXY_PORT` the same for Magpie, or fix `proxy_port`. |
| `403 unknown agent blocked` | Your organisation's allow-list must permit `claude-code`, `codex`, `gemini-cli`. |
| Magpie on one machine, Central on another | Not supported: the proxy only listens on 127.0.0.1. |

## Develop

```sh
bun test                      # unit tests, no Magpie or Central needed
```

Isolated Magpie sandbox that does not touch your real config (macOS/Linux):

```sh
export CENTRAL_HOME=$HOME/.jetbrains-central       # capture before HOME changes
export HOME=$(mktemp -d) XDG_CONFIG_HOME=$HOME/.config MAGPIE_ADDR=127.0.0.1:0
magpie plugin add ./
```

## License

[MIT](LICENSE)
