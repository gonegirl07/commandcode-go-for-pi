# commandcode-go-for-pi

Use a [Command Code](https://commandcode.ai) Go plan with [Pi Coding Agent](https://pi.dev) on Ubuntu and Windows.

This repo is a tested setup guide: install Command Code in Pi, write auth without wiping other providers, and check that models answer.

Pi is [Pi Coding Agent](https://pi.dev). Command Code support currently comes from [safzanpirani/pi-commandcode-provider](https://github.com/safzanpirani/pi-commandcode-provider). This repo does not contain that extension.

Unofficial. Not affiliated with Command Code or Pi. The extension uses an undocumented Command Code endpoint, so it can break, and a Go plan may not be treated as allowed. Pi packages run with your user access — read the extension before installing it.

## Tested

2026-08-15, extension commit [`c41f3b2`](https://github.com/safzanpirani/pi-commandcode-provider/commit/c41f3b2ee2fe226658da886dd36ba3f22cff0a43).

- Ubuntu, Pi 0.84.x: install, list models, file auth, live reply
- Windows 10 (PowerShell, cmd, Git Bash), Pi 0.84.1: install, list models, file-auth `pong`; env-only returned 401
- macOS: not tested

## Install

Need `pi` on PATH and a `user_...` key from https://commandcode.ai/settings

```console
pi install git:github.com/safzanpirani/pi-commandcode-provider
```

## Auth

Config dir: `$PI_CODING_AGENT_DIR` if set, else `~/.pi/agent`. On Windows that is often `%USERPROFILE%\.pi\agent`.

If `auth.json` exists, copy a backup. Merge the block below. Keep other providers. On Unix: `chmod 0600`.

```json
{
  "commandcode": {
    "type": "api_key",
    "key": "user_..."
  }
}
```

`auth.json` wins over env. The extension reads `COMMANDCODE_API_KEY`, not `COMMAND_CODE_API_KEY`. Prefer the file; env-only returned 401 on the Windows test machine.

## Check

```console
pi --list-models commandcode
pi --model commandcode/deepseek/deepseek-v4-flash -p "reply with exactly: pong"
```

If that model id is gone, use another from the list.

On Pi 0.84.x, `pi auth check --provider commandcode` said `not_ready` even when generate worked. Skip it.

## Remove

```console
pi remove git:github.com/safzanpirani/pi-commandcode-provider
```

Then delete the `commandcode` entry from `auth.json` if you want the key gone.

Setup issues: this repo. Extension / protocol: upstream. Account and billing: Command Code.

## License

[MIT](LICENSE)
