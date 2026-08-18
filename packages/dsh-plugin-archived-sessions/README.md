# dsh-plugin-archived-sessions

归档会话 / Archived Sessions — a DeepSeek Harness web plugin that adds an
independent **归档会话** page under Settings.

## Features

- List archived sessions grouped by DSH Workspace, with title, workspace, creation time, and last activity.
- Search and sort (last activity / creation time).
- Append-only infinite scroll (loaded pages are never replaced).
- Restore an archived session through the official DSH Workspace API.
- Permanently delete a session with an explicit risk confirmation.
- Realtime sync when the archive set changes.
- Light/Dark theme support and zh-CN / en locales.

## Requirements

- DeepSeek Harness **>= 0.1.0-rc.5** with the minimal upstream host extensions:
  `WorkspaceRegistry.unarchiveSession`, `SessionPersistence.delete`, session
  deletion orchestration, and the client runtime `workspaces.restoreSession`
  method. Public `0.1.0-rc.7` builds do **not** yet include
  `unarchiveSession`; use a development build containing those extensions (the
  upstream changes are kept separate for a future PR). The plugin performs a
  startup capability check and refuses to start on builds without the restore
  capability instead of crashing on click.
- The host must provide the official Typert Remote runtime and the shared web
  client modules listed in `peerDependencies`.

## Install

```bash
dsh plugin --profile <profile> add dsh-plugin-archived-sessions
```

Or install from a local tarball:

```bash
dsh plugin --profile <profile> add ./dsh-plugin-archived-sessions-0.1.0.tgz
```

After installation, open Settings → **归档会话**.

## Usage

- **恢复**: moves the session back into the active workspace. The action goes
  through the official `workspace.restoreSession` Host API, never a plugin
  private registry write, and removes the row only after the Host confirms.
- **永久删除**: permanently deletes the session and its history. This action is
  irreversible and requires checking the confirmation box.

## Development

```bash
pnpm install
pnpm --filter dsh-plugin-archived-sessions run build:host
pnpm --filter dsh-plugin-archived-sessions run build:client
```

## License

MIT
