# magpie-central-cli

Use the models behind a local JetBrains Central CLI proxy in Magpie
(three providers: `central-anthropic`, `central-openai`, `central-vertex`).
Design notes: [SPEC.md](SPEC.md).

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

## Install on another computer

Build the package once (any OS with npm):

```sh
npm pack --pack-destination dist     # or: npm run pack  → dist/magpie-central-cli-<version>.tgz
```

Move the `.tgz` to the target machine and unpack it into any folder. The
archive contains a `package/` directory, which is the plugin.

macOS / Linux:

```sh
mkdir magpie-central-cli && tar -xzf magpie-central-cli-0.2.1.tgz -C magpie-central-cli
magpie plugin add ./magpie-central-cli/package
```

Windows (PowerShell; `tar` ships with Windows 10 1803+):

```powershell
mkdir magpie-central-cli; tar -xzf magpie-central-cli-0.2.1.tgz -C magpie-central-cli
magpie plugin add .\magpie-central-cli\package
```

Use an absolute path if you plan to move the shell elsewhere. On macOS the
binary may be `/Applications/magpie.app/Contents/MacOS/magpie` when `magpie` is
not on `PATH`; on Windows use the full path to `magpie.exe` the same way.
Prefer a folder without spaces if your Magpie build complains about the path.

Then check:

```sh
magpie plugin --json                  # load errors, if any
magpie provider test central-anthropic
magpie provider test central-openai
magpie provider test central-vertex   # the built-in probe 404s for Google-style providers; chat in Magpie instead
```

Models are listed live through the proxy on all three routes. The plugin hides
nothing; Magpie only shows the ones you pick: `magpie provider models central-vertex`
lists them, `+<model>` exposes one. The list refreshes with Magpie's own model
refresh. Options (see SPEC.md):

```sh
magpie plugin options central-cli '{"exclude":["-eap$"],"models":{"vertex":["gemini-3.5-flash"]}}'
```

On PowerShell quote the JSON as `'{\"exclude\":[\"-eap$\"]}'` (or use a here-string).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Providers show "需要运行登录 central-cli" | `central login`, start the proxy, then sign in again. `central status` should show it running. |
| `cannot read …config.json` in the Magpie log | Central never ran on this user account, or `CENTRAL_HOME`/`HOME`/`USERPROFILE` differ between the shell that started Central and the one that started Magpie. |
| `proxy not reachable on 127.0.0.1:<port>` | Proxy stopped, or Central uses another port: set `WIRE_PROXY_PORT` the same for Magpie, or fix `proxy_port`. |
| `403 unknown agent blocked` | Your organisation's allow-list must permit `claude-code`, `codex`, `gemini-cli` (see SPEC.md). |
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
