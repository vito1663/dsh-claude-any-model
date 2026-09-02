# Installation Runbook

Idempotent steps for a local checkout of this plugin and an existing DSH `web` profile. The plugin never asks for or stores Claude credentials; authenticate through the local Claude Code CLI before using it.

## 1. Verify the checkout

```sh
cd /path/to/dsh-claude-any-model
pnpm install
pnpm check          # typecheck + tests + build
node lib/bin.mjs doctor
```

Stop if Doctor cannot find an authenticated local Claude Code installation. Do not request, copy, or write credentials.

## 2. Link the bundle into the current Web profile

```sh
dsh plugin --profile web add "link:$(pwd)"
```

Wait for the profile rebuild to finish, then restart DSH if requested. Do not start another DSH Web server — the bundle must load in the existing app.

## 3. Smoke test

1. Refresh the DSH Web page.
2. Create a new conversation, open the model picker, and check the **Claude** group: it should list your DSH-registered models as `provider::model` rows.
3. Pick one and send a read-only prompt; verify the reply streams and the session's activity appears.
4. Send one edit prompt; verify DSH displays a permission request. Exercise reject first, then allow once with a harmless temporary file.
5. Cancel a running prompt and confirm no orphaned `claude` process keeps executing cancelled work.
6. Restart DSH and confirm the next prompt resumes the persisted Claude session.

A live prompt consumes the configured model's quota. Keep the smoke test minimal.

## 4. Uninstall

Clean up the managed preset while the profile can still execute the package CLI, then remove the plugin:

```sh
dsh plugin --profile web exec dsh-claude remove-preset
dsh plugin --profile web remove dsh-claude-any-model
```

DSH has no plugin uninstall lifecycle hook, so direct package removal can leave the compatibility preset behind. After direct removal, run the matching package version from a cache instead of a checkout:

```sh
pnpm dlx dsh-claude-any-model@<version> remove-preset
```

Cleanup refuses to delete user-modified preset content.

## 5. Bridge artifacts

The Anthropic bridge keeps two files under `~/.dsh/`:

- `anthropic-bridge-token` — the loopback auth token (persists across restarts; delete to rotate).
- `dsh-claude-bridge.log` — only written when `DSH_CLAUDE_BRIDGE_DEBUG=1`.

Both are safe to delete while DSH is stopped.
