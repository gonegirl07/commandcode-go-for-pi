# Command Code Go/GOAT for Pi

Use [Command Code](https://commandcode.ai) Go or GOAT plans as a provider in [Pi Coding Agent](https://pi.dev). This repository is a self-contained Pi extension: one install registers the `commandcode` provider, native `/alpha/generate` transport, dynamic model catalog refresh, tool calling, reasoning controls, and `/cc-usage`.

Unofficial and not affiliated with Command Code or Pi. Generation and billing use undocumented `/alpha/*` routes that may change. Review the source before installation; Pi extensions run with your user permissions.

The provider implementation is based on the MIT-licensed [`safzanpirani/pi-commandcode-provider`](https://github.com/safzanpirani/pi-commandcode-provider), with local reasoning, authentication, packaging, catalog, usage, and regression-test updates.

## Requirements

- Pi 0.84.2 or newer and Node.js 22.19 or newer.
- A `user_...` key from [Command Code settings](https://commandcode.ai/settings).
- A Command Code Go or GOAT plan that permits the selected model.

Command Code documents Go as a $1/month plan with $10 monthly credits for open models plus some premium models, and GOAT as a $10/month plan with $70 credits and broader model access. The official provider API is documented separately and may exclude Go; this extension keeps the native `/alpha/generate` path so Go users continue to work.

## Install

If an older Command Code Pi provider or the separate `commandcode-usage-for-pi` extension is installed, remove it first so only this package registers `commandcode` and `/cc-usage`:

```console
pi install git:github.com/gonegirl07/commandcode-go-for-pi
```

Restart Pi or run `/reload` after installation.

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

Bar color follows the active Pi theme: green below 70% used, yellow 70–90%, red at or above 90%. The line refreshes on startup, when the agent settles, on `/model`, and every 60 seconds while it is shown. Switching to a non-Command Code model hides it. Plans without rolling windows omit those segments instead of inventing numbers. A later billing error keeps the last good line instead of clearing it.

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
```

Reset times use the local timezone. The command reuses Pi's `commandcode` API key, then falls back to `COMMANDCODE_API_KEY`. It does not read `~/.commandcode/auth.json`.

## Verify

```console
pi --list-models commandcode
pi --model commandcode/deepseek/deepseek-v4-pro --thinking high -p "reply exactly: high-ok"
pi --model commandcode/deepseek/deepseek-v4-pro --thinking max -p "reply exactly: max-ok"
```

Use another model returned by `--list-models` if a model is unavailable on your plan. On Pi 0.84.x, `pi auth check --provider commandcode` may report `not_ready` even when generation works.

## Update and Remove

```console
pi update git:github.com/gonegirl07/commandcode-go-for-pi
pi remove git:github.com/gonegirl07/commandcode-go-for-pi
```

Removing the package does not delete the `commandcode` credential from `auth.json`.

## Development

```console
npm install --include=dev
npm test
npm run check
```

Tests capture the actual serialized request body and verify that reasoning fields never leak to unsupported levels or unrelated models. Catalog tests cover the public provider model shape, `/cc-usage` formatting, and the compact quota bar below the editor.

## License

[MIT](LICENSE)
