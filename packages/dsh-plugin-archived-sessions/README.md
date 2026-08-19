# dsh-plugin-archived-sessions

归档会话 / Archived Sessions — a DeepSeek Harness web plugin that adds an
independent **归档会话** page under Settings.

## Features

- List archived sessions grouped by DSH Workspace, with title, workspace, creation time, and last activity.
- Search and sort (last activity / creation time).
- Append-only infinite scroll (loaded pages are never replaced).
- Restore an archived session through a Host-side compatibility adapter.
- Permanently delete a session with an explicit risk confirmation.
- Realtime sync when the archive set changes, without flashing the list back to a loading state.
- Light/Dark theme support and zh-CN / en locales.

## Requirements

- DeepSeek Harness **>= 0.1.0-rc.6** (DSH Desktop 0.1.0-rc.6 and later). The
  plugin never hard-requires a specific runtime capability: the Host
  capability-detects the restore path at startup and degrades gracefully.
- The host must provide the official Typert Remote runtime and the shared web
  client modules listed in `peerDependencies`.

### Restore capability matrix

| Runtime | Detection | Restore path |
| --- | --- | --- |
| Future DSH with official `WorkspaceRegistry.unarchiveSession` | `typeof registry.unarchiveSession === 'function'` | Native API |
| DSH 0.1.0-rc.6 (no `unarchiveSession`, registry mutation surface present) | `enqueueOperation` / `requireState` / `setState` all functions | rc.6 compat path (`archivedSessionIds` rewrite through the registry's own serialized mutation chain) |
| Any other runtime | neither | `restore-unsupported` domain result; the plugin still starts and lists |

Detection is pure runtime capability probing — never a version-string check —
so a future DSH that adds the official API is adopted automatically and the
rc.6 shim stops running. No DSH source, prototype, or storage file is
touched; the adapter calls the runtime's own methods on the live registry
instance, and the rc.6 path rewrites only `archivedSessionIds`, leaving
workspace `sessionIds` accounting and order intact.

Permanent delete is similarly capability-gated: on runtimes without
`SessionPersistence.delete` the action is disabled in the UI and the Host
answers `delete-unsupported`, instead of failing plugin startup.

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

- **恢复**: moves the session back into its original workspace slot and
  position. The action goes through the Host compatibility adapter (native
  `unarchiveSession` when available, rc.6 mutation path otherwise) and
  removes the row only after the Host confirms.
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
