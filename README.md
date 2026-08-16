# Command Code Go for Pi

Use a [Command Code](https://commandcode.ai) Go plan as a provider in [Pi Coding Agent](https://pi.dev). This repository is a self-contained Pi extension: one install registers the provider, model catalog, `/alpha/generate` transport, tool calling, and reasoning controls.

Unofficial and not affiliated with Command Code or Pi. The extension uses an undocumented endpoint that may change. Review the source before installation; Pi extensions run with your user permissions.

The provider implementation is based on the MIT-licensed [`safzanpirani/pi-commandcode-provider`](https://github.com/safzanpirani/pi-commandcode-provider), with local reasoning, authentication, packaging, and regression-test updates.

## Requirements

- Pi 0.84.2 or newer and Node.js 22.19 or newer.
- A `user_...` key from [Command Code settings](https://commandcode.ai/settings).
- A Command Code plan that permits the selected model.

## Install

If the older upstream provider is installed, remove it first so only one extension registers `commandcode`:

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

## Reasoning

DeepSeek V4 Pro and V4 Flash expose only levels verified by Command Code:

| Pi level | Request behavior |
| --- | --- |
| `off` | Omits `params.reasoning_effort` |
| `high` | Sends `params.reasoning_effort: "high"` |
| `max` | Sends `params.reasoning_effort: "max"` |

Unsupported levels are not forwarded. Other models keep their existing gateway-selected reasoning behavior.

## Verify

```console
pi --list-models commandcode
pi --model commandcode/deepseek/deepseek-v4-pro --thinking high -p "reply exactly: high-ok"
pi --model commandcode/deepseek/deepseek-v4-pro --thinking max -p "reply exactly: max-ok"
```

Model availability can change; use another model returned by `--list-models` if necessary. On Pi 0.84.x, `pi auth check --provider commandcode` may report `not_ready` even when generation works.

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

Tests capture the actual serialized request body and verify that reasoning fields never leak to unsupported levels or unrelated models.

## License

[MIT](LICENSE)
