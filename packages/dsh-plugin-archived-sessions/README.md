# dsh-plugin-archived-sessions

归档会话 / Archived Sessions — a DeepSeek Harness web plugin that adds an
independent **归档会话** page under Settings.

## Features

- List archived sessions grouped by DSH Workspace, with title, workspace, creation time, and last activity.
- Search and sort (last activity / creation time).
- Append-only infinite scroll (loaded pages are never replaced).
- Restore an archived session through a Host-side compatibility adapter.
- Permanently delete a session (removes its durable log) with an explicit risk confirmation.
- Clear one workspace group's archived sessions, or remove a Workspace registration from the workspace list.
- Realtime sync when the archive set changes, without flashing the list back to a loading state.
- Light/Dark theme support and zh-CN / en locales.

## Requirements

- DeepSeek Harness **>= 0.1.0-rc.6** (DSH Desktop 0.1.0-rc.6 and later). The
  plugin never hard-requires a specific runtime capability: the Host
  capability-detects every destructive path at startup and degrades gracefully.
- The host must provide the official Typert Remote runtime and the shared web
  client modules listed in `peerDependencies`.

### Restore capability matrix

| Runtime | Detection | Restore path |
| --- | --- | --- |
| DSH 0.1.7+ with official `WorkspaceRegistry.unarchiveSession` | `typeof registry.unarchiveSession === 'function'` | Native API |
| DSH 0.1.0-rc.6 – 0.1.5 (no `unarchiveSession`, registry mutation surface present) | `enqueueOperation` / `requireState` / `setState` all functions | Compat path (`archivedSessionIds` rewrite through the registry's own serialized mutation chain) |
| Any other runtime | neither | `restore-unsupported` domain result; the plugin still starts and lists |

Detection is pure runtime capability probing — never a version-string check —
so a future DSH that adds the official API is adopted automatically and the
compat shim stops running. No DSH source, prototype, or storage file is
touched; the adapter calls the runtime's own methods on the live registry
instance, and the compat path rewrites only `archivedSessionIds`, leaving
workspace `sessionIds` accounting and order intact.

### Delete capability matrix

**DSH ships no session-deletion API in any released version.** The persistence
seam is `create` / `open` / `stat` / `list` / `flush`, and the shipped JSONL
backend documents that its logs accumulate under the root "until removed
externally". Permanently deleting a session therefore means the Host removes
the durable log artifacts itself.

| Runtime | Detection | Delete path |
| --- | --- | --- |
| DSH 0.1.7+ JSONL backend | `sessionPersistence.listArtifacts` is a function | Authoritative path from the backend's own listing; the Host removes every canonical log generation of that session |
| Runtime with only `sessionPersistence.locate` | `listArtifacts` absent, `locate` present | Path derived from the stored header |
| Any other runtime | neither | `unsupported`: both delete actions are disabled in the UI and the Host answers `delete-unsupported` / `workspace-delete-unsupported` |

Removal is deliberately narrow, because the backend reopens a session's log by
path on every append:

- Only artifacts **inside the backend's own root** are touched; every resolved
  path is fenced by a resolved-root prefix check before anything is removed.
- Only **session-owned files** are removed: every canonical log generation
  (`session.jsonl`, `session.vN.jsonl`, `*.zstd` or plain — a surviving older
  generation would resurrect the session through the migration path), the POSIX
  `session.lock` residue, and `*.tmp` leftovers. Unknown files survive, and the
  session directory is removed only when it is empty afterwards.
- The shared project directory is never removed, even when its last session
  goes.
- A session that is **live or running is refused**, never force-removed.
  Deleting a log that still has a writer would make the backend recreate a
  headerless file on the next batch — "deleted" would become "corrupt".

Workspace registration removal is separate and uses the official
`WorkspaceRegistry.delete(id)`: the registration leaves the workspace list
while its directory, its files and every session log are kept, and its sessions
fall back to Ungrouped.

## Install

```bash
dsh plugin --profile <profile> add dsh-plugin-archived-sessions
```

Or install from a local tarball:

```bash
dsh plugin --profile <profile> add ./dsh-plugin-archived-sessions-0.2.0.tgz
```

After installation, open Settings → **归档会话**.

## Usage

- **恢复**: moves the session back into its original workspace slot and
  position. The action goes through the Host compatibility adapter (native
  `unarchiveSession` when available, compat mutation path otherwise) and
  removes the row only after the Host confirms.
- **删除** (session row): permanently deletes that session and its durable log.
  Irreversible, and requires checking the confirmation box. A running session
  cannot be deleted.
- **清空归档会话** (workspace group header): permanently deletes every archived
  session of that group, including their on-disk logs. The workspace itself,
  its project directory, its files and its non-archived sessions are kept.
- **删除工作区** (workspace group header): removes the Workspace registration
  from the DeepSeek Harness workspace list. The folder, its files and every
  session log are kept, and the sessions appear under Ungrouped. Archived
  sessions stay in the archive list — this action deletes no session.

Two known limits: only *archived* sessions have an entry here, so a normal
unarchived session cannot be deleted from this page; and deleting a session
does not recurse into its subagent child sessions, which are separate sessions
with their own logs.

## Development

```bash
pnpm install
pnpm --filter dsh-plugin-archived-sessions run build:host
pnpm --filter dsh-plugin-archived-sessions run build:client
```

## License

MIT
