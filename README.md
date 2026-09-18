# Command Code Go/GOAT for Pi

Use [Command Code](https://commandcode.ai) Go or GOAT plans as a provider in [Pi Coding Agent](https://pi.dev). This repository is a self-contained Pi extension: one install registers the `commandcode` provider, native `/alpha/generate` transport, dynamic model catalog refresh, tool calling, reasoning controls, `/cc-usage`, and `/cc-keys` for automatic failover across several API keys.

The same repository is an [Oh My Pi](https://github.com/oh-my-pi) plugin. omp already ships the `commandcode` provider, so there the extension only customizes it — quota bar, usage limits, `/cc-usage`, and the same `/cc-keys` failover — without replacing its catalog, pricing, or routing.

Unofficial and not affiliated with Command Code or Pi. Generation and billing use undocumented `/alpha/*` routes that may change. Review the source before installation; Pi extensions run with your user permissions.

The provider implementation is based on the MIT-licensed [`safzanpirani/pi-commandcode-provider`](https://github.com/safzanpirani/pi-commandcode-provider), with local reasoning, authentication, packaging, catalog, usage, and regression-test updates.

## Requirements

- Pi 0.84.2 or newer and Node.js 22.19 or newer.
- A `user_...` key from [Command Code settings](https://commandcode.ai/settings).
- A Command Code Go or GOAT plan that permits the selected model.

Command Code documents Go as a $1/month plan with $10 monthly credits for open models plus some premium models, and GOAT as a $10/month plan with $70 credits and broader model access. The official provider API is documented separately and may exclude Go; this extension keeps the native `/alpha/generate` path so Go users continue to work.

## Install

If an older Command Code Pi provider or the separate `commandcode-usage-for-pi` extension is installed, remove it first so only this package registers `commandcode`, `/cc-usage`, and `/cc-keys`:

```console
pi install git:github.com/gonegirl07/commandcode-go-for-pi
```

Restart Pi or run `/reload` after installation.

For omp, the same repository installs as a plugin — one command, no provider added:

```console
omp install github:gonegirl07/commandcode-go-for-pi
```

See [Oh My Pi (omp)](#oh-my-pi-omp) for what that extension does and how keys are managed there.

## Authentication

Pi's config directory is `$PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. Back up an existing `auth.json`, then merge this entry without deleting other providers:

```json
{
  "commandcode": {
    "type": "api_key",
    "key": "user_..."
  }
}
```

On Unix, protect the file with `chmod 0600 ~/.pi/agent/auth.json`. The `COMMANDCODE_API_KEY` environment variable is also supported.

## Multiple API keys

Command Code meters its 5-hour, weekly, and monthly quota per account, so extra keys keep the provider working when one runs dry. Manage them from inside Pi:

```console
/cc-keys add user_...
/cc-keys
/cc-keys remove 2
```

Extra keys are stored in `$PI_CODING_AGENT_DIR/commandcode-keys.json` (default `~/.pi/agent/commandcode-keys.json`, mode `0600`), in the order they were added. The pool is the key Pi resolved first — `auth.json`, else `COMMANDCODE_API_KEY` — followed by the file; `/cc-keys` reports where each key came from. Setting `COMMANDCODE_API_KEYS="user_a,user_b"` replaces the whole pool instead.

When a key exhausts a window, the provider parks it until the reset time Command Code's billing API reports and moves on:

- A parked key is skipped for later requests, so no doomed call is made.
- If the key runs out mid-request, the same request is re-sent with the next key, provided no text or tool call has streamed yet. Output is never duplicated or restarted.
- When every key is parked, the request fails immediately with the next reset time instead of an opaque gateway error.

Parking lives in memory for the current Pi process: restarting Pi or running `/reload` clears it and re-probes every key. The quota bar shows `#2/3` for the key in use, and `/cc-usage` reports the active key.

## Oh My Pi (omp)

omp ships its own first-class `commandcode` provider, so nothing here registers a second one. [`omp/commandcode-quota.ts`](omp/commandcode-quota.ts) attaches to the provider omp already has — quota bar, `omp usage` limits, `/cc-usage`, and the same multi-key failover — and leaves its catalog, KDL deployment contract, routing, effort ladders, and pricing untouched (`registerProvider` with `usage` only, no `models`).

Install from the same repository with one command:

```console
omp install github:gonegirl07/commandcode-go-for-pi
```

`package.json` carries an `omp` manifest (`omp.extensions`), so omp loads that file from the installed package; `pi install` still uses `pi.extensions` and gets the pi provider. From a local checkout, `omp install /path/to/commandcode-go-for-pi` links the directory instead, so edits apply without reinstalling. `omp plugin list` shows the plugin, and `omp plugin uninstall commandcode-go-for-pi` removes it.

If an earlier copy of this file was placed in `~/.omp/agent/extensions/`, delete it so `cc-quota` and `/cc-keys` are registered once.

Keys live in omp's own credential store (`~/.omp/agent/agent.db`), so they are shared with `/login commandcode` and the auth broker:

```console
/cc-keys add user_...
/cc-keys
/cc-keys remove 2
```

Failover works by parking, not by proxying: before a turn and before every provider request the extension checks the active key's billing windows, and parks a key whose 5-hour, weekly, or monthly quota is spent until the reset time Command Code reports. omp then selects the next stored key, so the request never leaves on a key with nothing left. Parking survives restarts (omp keeps credential blocks in `agent.db`); when every key is parked the bar says so and names the next reset. If quota runs out between the check and the request, omp retries and the next request moves to the next key.

The quota bar shows `#2/3` for the key omp is using, and `COMMANDCODE_BASE_URL` points the billing calls at a proxy or test server.

## Models

The extension fetches the public Command Code model catalog from:

```console
https://api.commandcode.ai/provider/v1/models
```

Pi supports async extension startup and `refreshModels`, so the catalog is loaded at startup and can be refreshed with:

```console
pi update --models
pi --list-models commandcode
```

If the catalog endpoint is unavailable, Pi falls back to the bundled static catalog. Model availability still depends on your Command Code plan and current Command Code routing.

To refresh the bundled fallback snapshot before a release, compare the public provider response with `cmd --list-models`, then update `FALLBACK_PROVIDER_MODELS` in `index.ts` with the canonical IDs, names, and context lengths.

Command Code also documents model discovery through:

```console
npm i -g command-code
cmd --list-models
```

## Reasoning

DeepSeek V4 Pro and V4 Flash expose only levels verified by Command Code:

| Pi level | Request behavior |
| --- | --- |
| `off` | Omits `params.reasoning_effort` |
| `high` | Sends `params.reasoning_effort: "high"` |
| `max` | Sends `params.reasoning_effort: "max"` |

Unsupported levels are not forwarded. Other reasoning-capable models are marked conservatively from Command Code's model docs and local verification, but this extension does not invent model-specific thinking parameters for them; the gateway keeps its native/default behavior.

## Usage

When a Command Code model is selected, a compact usage bar appears directly below the chat input:

```text
5h ▓▓░░░░░░░░ 18%   Wk ▓░░░░░░░░░  8%   Mo ▓░░░░░░░░░ 11%
```

| Segment | Meaning |
| --- | --- |
| `5h` | Rolling 5-hour usage window |
| `Wk` | Weekly usage window |
| `Mo` | Monthly credit allocation |
| `▓▓░░░░░░░░ 18%` | How much of that window is already used |

Bar color follows the active Pi theme: green below 70% used, yellow 70–90%, red at or above 90%. With several keys configured, the line starts with the key serving requests and the pool size, e.g. `#2/3 5h ▓▓░░░░░░░░ 18% ...`; when every key is parked it reads `All 3 Command Code keys are quota-limited · next reset ...`. The line refreshes on startup, when the agent settles, on `/model`, and every 60 seconds while it is shown. Switching to a non-Command Code model hides it. Plans without rolling windows omit those segments instead of inventing numbers. A later billing error keeps the last good line instead of clearing it.

This package also includes the former `commandcode-usage-for-pi` command for a detailed dollar report:

```console
/cc-usage
```

Example:

```text
Command Code  individual-goat
Month    $62.50 / $70 left
5-hour   $1.00 / $10    reset Sep 12, 14:00
Week     $4.00 / $40    reset Sep 15, 14:00
Cycle    ends Sep 30, 2026
Key      #2/3  user_ab12…9f4c
```

Reset times use the local timezone. The command resolves keys the same way generation does — Pi's `commandcode` credential, else `COMMANDCODE_API_KEY`, then the extra keys from the keys file — and adds the `Key` line only when more than one key is configured. It does not read `~/.commandcode/auth.json`.

## Verify

```console
pi --list-models commandcode
pi --model commandcode/deepseek/deepseek-v4-pro --thinking high -p "reply exactly: high-ok"
pi --model commandcode/deepseek/deepseek-v4-pro --thinking max -p "reply exactly: max-ok"
```

Use another model returned by `--list-models` if a model is unavailable on your plan. On Pi 0.84.x, `pi auth check --provider commandcode` may report `not_ready` even when generation works.

To exercise failover, add a key that cannot work ahead of a valid one and check that generation still succeeds:

```console
PI_CODING_AGENT_DIR=/tmp/cc-check pi --no-extensions --extension ./index.ts --model commandcode/deepseek/deepseek-v4-pro -p "reply exactly: failover-ok"
```

With `/tmp/cc-check/auth.json` holding an invalid `user_...` key and `/tmp/cc-check/commandcode-keys.json` holding a valid one, the invalid key is rejected, parked, and the request re-sent with the valid key.

## Update and Remove

```console
pi update git:github.com/gonegirl07/commandcode-go-for-pi
pi remove git:github.com/gonegirl07/commandcode-go-for-pi
```

For omp, re-running the install picks up a new revision (a local link already tracks the checkout):

```console
omp install github:gonegirl07/commandcode-go-for-pi
omp plugin uninstall commandcode-go-for-pi
```

Removing the package does not delete the `commandcode` credential from Pi's `auth.json` or omp's credential store, and it leaves any keys you added alone.

## Development

```console
npm install --include=dev
npm test
npm run check
```

Tests capture the actual serialized request body and verify that reasoning fields never leak to unsupported levels or unrelated models. Catalog tests cover the public provider model shape, `/cc-usage` formatting, and the compact quota bar below the editor. Key tests drive failover with mocked gateways: rejection mid-request rotates to the next key, a parked key is skipped for later requests, a key that already streamed content is never retried, and an all-parked pool fails before the request is sent. `test/omp-quota.test.mjs` covers the omp extension's window-exhaustion math.

## License

[MIT](LICENSE)
