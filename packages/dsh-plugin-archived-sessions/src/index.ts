/**
 * Archived Sessions plugin Host half.
 *
 * Exposes the official DSH Typert Remote API consumed by the Settings page:
 * list archived sessions, restore one, permanently delete one, permanently
 * delete one archived group, and remove a Workspace registration. Restore is
 * routed through the plugin's own {@link ArchiveCompatibilityAdapter}, which
 * capability-detects the runtime — the official
 * `WorkspaceRegistry.unarchiveSession` when it exists, the rc.6
 * `enqueueOperation` / `requireState` / `setState` mutation surface
 * otherwise — so the service starts on every DSH build and degrades to a
 * `restore-unsupported` domain result only where no path exists.
 *
 * Permanent delete has no official backing in any released DSH: the
 * persistence seam is `create` / `open` / `stat` / `list` / `flush`, and the
 * shipped JSONL backend documents that logs accumulate under its root "until
 * removed externally". The Host therefore removes the durable log itself,
 * through {@link SessionLogDeleter}, which uses only the backend's own
 * listing surfaces (`listArtifacts`, falling back to `locate`) to resolve the
 * authoritative artifact path, refuses any path outside the backend's root,
 * and removes only session-owned log artifacts. On a runtime exposing neither
 * surface the capability reports `unsupported`, the UI disables the action,
 * and the Remote answers `delete-unsupported` instead of failing startup. The
 * archive-set cleanup after a delete routes through the same adapter
 * primitive as restore.
 *
 * Removing a Workspace registration goes through
 * {@link WorkspaceRegistrationDeleter}: the official
 * `WorkspaceRegistry.delete(id)`, whose semantics are deliberately
 * non-destructive — the registration leaves the workspace list while its
 * directory and every session log are retained, and its sessions fall back to
 * Ungrouped.
 *
 * Every durable removal refuses to run against a live or running session: the
 * JSONL backend reopens a session's log by path on each append, so deleting a
 * log that still has a writer would recreate a headerless file instead of
 * producing a clean absence.
 *
 * @module dsh-plugin-archived-sessions
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ArchiveCompatibilityAdapter } from './host/compat/restore.ts'
import { SessionLogDeleter } from './host/session-log.ts'
import { WorkspaceRegistrationDeleter } from './host/workspace-registration.ts'
import type {
  ArchivedSessionDeleteRequest,
  ArchivedSessionDeleteValue,
  ArchivedSessionDetail,
  ArchivedSessionItem,
  ArchivedSessionListResult,
  ArchivedSessionRestoreRequest,
  ArchivedSessionRestoreValue,
  ArchivedSessionsCapabilities,
  ArchivedSessionsDetailsRequest,
  ArchivedSessionsDetailsResult,
} from './types.ts'
import type { ArchivedSessionRunningError } from './types.ts'
import type {
  ArchivedWorkspaceDeleteRequest,
  ArchivedWorkspaceDeleteValue,
} from './types.ts'
import type {
  ArchivedWorkspaceRegistrationDeleteRequest,
  ArchivedWorkspaceRegistrationDeleteValue,
} from './types.ts'

/** Minimal workspace shape used by the archived-sessions host surface. */
interface ArchivedWorkspace {
  id: string
  title: string
  path: string
  sessionIds: readonly SessionId[]
  detachSession(sessionId: SessionId): Promise<void> | void
}

/**
 * Minimal workspace-registry surface used by the archived-sessions host.
 * `unarchiveSession` is intentionally optional: rc.6–0.1.5 runtimes expose
 * only the archive set and their internal mutation path, which the
 * compatibility adapter probes at runtime. `delete` is the official
 * registration-removal primitive and is optional for the same reason.
 */
interface ArchivedWorkspaceRegistry {
  archivedSessionIds: readonly SessionId[]
  list(): readonly ArchivedWorkspace[]
  unarchiveSession?(sessionId: SessionId): Promise<void>
  delete?(workspaceId: string): Promise<boolean>
}

/**
 * Minimal durable-session-persistence surface used by the archived-sessions
 * host. Every member is optional because the storage contract was reshaped
 * between DSH builds and the plugin probes the runtime instead of comparing
 * version strings:
 *
 *   - `listSnapshots()` (rc.5–rc.8) and `list()` (0.1.5+) both yield stored
 *     session headers; listing needs one of them.
 *   - `readFrom(id, 0)` (rc.5–rc.8) and `open(id, 'read')` + a read handle
 *     (0.1.5+) both read one session's event log; a runtime with neither still
 *     lists header-only rows.
 *   - `root`, `listArtifacts()` and `locate()` are the JSONL backend's
 *     artifact-position surfaces and back permanent delete. DSH has no
 *     session-deletion API in any released version, so removal needs a way to
 *     name the stored artifact; without one the delete capability reports
 *     `unsupported` and the plugin keeps running with the actions disabled.
 */
interface ArchivedSessionPersistence {
  readonly root?: string
  listSnapshots?(): Promise<readonly { header: SessionHeader }[]>
  list?(): Promise<readonly { header: SessionHeader }[]>
  readFrom?(sessionId: SessionId, offset: number): Promise<{ events: readonly SessionEvent[] }>
  open?(sessionId: SessionId, access: 'read'): Promise<ArchivedSessionHandle>
  listArtifacts?(signal?: AbortSignal): Promise<
    readonly { readonly header: SessionHeader; readonly path: string }[]
  >
  locate?(header: SessionHeader): { readonly kind?: string; readonly path: string } | undefined
}

/** Minimal read-handle surface of the 0.1.5+ `SessionPersistence.open` contract. */
interface ArchivedSessionHandle {
  read(offset?: number): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

/**
 * Minimal live-session shape. The `events` getter (rc.5–rc.8) became
 * `snapshotEvents()` in 0.1.5+; either accessor may be absent, so both are
 * runtime probes and a session with neither contributes no events.
 */
interface ArchivedLiveSession {
  header: SessionHeader
  events?: readonly SessionEvent[]
  snapshotEvents?(): readonly SessionEvent[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    archivedSessions: ArchivedSessionsService
    workspaceRegistry: ArchivedWorkspaceRegistry
    sessionPersistence: ArchivedSessionPersistence
    agents: {
      get(sessionId: SessionId): { status: 'idle' | 'running' } | undefined
    }
    sessions: {
      get(sessionId: SessionId): ArchivedLiveSession | undefined
    }
  }
}

/** Cap for the fallback title text derived from a first user message. */
const FALLBACK_TITLE_MAX_CHARS = 48

/**
 * How many stored logs one `details` request reads at once. The backend's read
 * path is per-session I/O plus decode, so a bounded fan-out keeps the host
 * responsive while a revealed batch still resolves in one round trip.
 */
const DETAILS_READ_CONCURRENCY = 8

/**
 * Thrown by {@link ArchivedSessionsService.deleteOne} when a session becomes
 * running between an entry point's capability/preflight check and the actual
 * deletion. Entry points translate this into `session-running` /
 * `workspace-sessions-running` domain results instead of deleting a live
 * session.
 */
class SessionRunningError extends Error {
  readonly code = 'session-running' as const
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`cannot delete session "${sessionId}": session is running`)
    this.name = 'SessionRunningError'
    this.sessionId = sessionId
  }
}

function isSessionRunningError(error: unknown): error is SessionRunningError {
  return error instanceof SessionRunningError
}

/** Whether a persistence-layer rejection means the session became live/running. */
function isLiveDeleteError(error: unknown): boolean {
  return isSessionRunningError(error) || /while it is live|while it is running/u.test(String(error))
}

/**
 * Thrown by {@link ArchivedSessionsService.deleteOne} when the requested id is
 * no longer present in the archived-session set (a concurrent restore or
 * deletion already removed it).
 */
class SessionNotFoundError extends Error {
  readonly code = 'session-not-found' as const
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`cannot delete session "${sessionId}": not in the archived session set`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

/** Extract plain text from a user message's content blocks, if representable. */
function firstUserText(events: readonly SessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const content = (event.data as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    const text = content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block !== null && typeof block === 'object' && 'type' in block) {
          const typed = block as { type?: unknown; text?: unknown }
          if (typed.type === 'text' && typeof typed.text === 'string') return typed.text
        }
        return ''
      })
      .join('')
      .replace(/\s+/gu, ' ')
      .trim()
    if (text.length > 0) return text
  }
  return undefined
}

/** Id-derived placeholder a row shows before (or without) its log being read. */
function fallbackTitle(sessionId: string): string {
  return `会话 ${sessionId.slice(0, 8)}`
}

/** Latest user-pinned or provider-derived title event, or a fallback label. */
function deriveTitle(events: readonly SessionEvent[], sessionId: string): string {
  for (const event of [...events].reverse()) {
    if ((event.type as string) !== 'session/title') continue
    const title = (event.data as { title?: unknown }).title
    if (typeof title === 'string' && title.trim() !== '') return title
  }
  const first = firstUserText(events)
  if (first !== undefined) {
    return first.length > FALLBACK_TITLE_MAX_CHARS
      ? `${first.slice(0, FALLBACK_TITLE_MAX_CHARS)}…`
      : first
  }
  return fallbackTitle(sessionId)
}

/** Later of creation and the latest human prompt / title event. */
function sessionUpdatedAt(header: SessionHeader, events: readonly SessionEvent[]): number {
  let last = header.createdAt
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      last = Math.max(last, event.time)
    } else if ((event.type as string) === 'session/title') {
      last = Math.max(last, event.time)
    }
  }
  return last
}

/** Latest human prompt / title event time, or `0` when the log carries none. */
function sessionLastActivity(events: readonly SessionEvent[]): number {
  let last = 0
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      last = Math.max(last, event.time)
    } else if ((event.type as string) === 'session/title') {
      last = Math.max(last, event.time)
    }
  }
  return last
}

/**
 * A live session's events through whichever accessor this runtime ships: the
 * `events` getter through rc.8, `snapshotEvents()` from 0.1.5 on.
 */
function liveSessionEvents(session: ArchivedLiveSession): readonly SessionEvent[] {
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return []
}

/**
 * One archived session's display row. `events === undefined` is the
 * header-only row: no log was read, so the title is the id-derived placeholder
 * and the last activity falls back to creation time.
 */
function item(
  sessionId: string,
  header: SessionHeader,
  events: readonly SessionEvent[] | undefined,
  running: boolean,
  workspace: { id: string; title: string; path: string } | undefined,
): ArchivedSessionItem {
  return {
    sessionId,
    title: events === undefined ? fallbackTitle(sessionId) : deriveTitle(events, sessionId),
    ...(workspace === undefined ? {} : {
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      workspacePath: workspace.path,
    }),
    createdAt: header.createdAt,
    lastActivityAt: events === undefined ? header.createdAt : sessionUpdatedAt(header, events),
    running,
    detailsLoaded: events !== undefined,
  }
}

/**
 * Host Remote service for the archived-sessions manager.
 */
export class ArchivedSessionsService extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents']

  private readonly archiveAdapter: ArchiveCompatibilityAdapter
  private readonly sessionLogs: SessionLogDeleter
  private readonly workspaceRegistrations: WorkspaceRegistrationDeleter

  constructor(ctx: Context) {
    // No startup capability gate: every destructive path is capability-detected
    // rather than assumed. On a runtime that cannot locate a stored session log
    // the capability reports `unsupported`, the UI disables the delete actions,
    // and the Remote answers a domain result — never a startup failure.
    super(ctx, 'archivedSessions')
    this.archiveAdapter = new ArchiveCompatibilityAdapter(ctx.workspaceRegistry)
    this.sessionLogs = new SessionLogDeleter({
      // The seam exposes `root` only on the shipped backend; the empty-string
      // fallback keeps construction total, and every path is still fenced by
      // the resolved-root prefix check before anything is removed.
      root: ctx.sessionPersistence.root ?? '',
      ...(typeof ctx.sessionPersistence.listArtifacts === 'function'
        ? { listArtifacts: ctx.sessionPersistence.listArtifacts.bind(ctx.sessionPersistence) }
        : {}),
      ...(typeof ctx.sessionPersistence.locate === 'function'
        ? { locate: ctx.sessionPersistence.locate.bind(ctx.sessionPersistence) }
        : {}),
    })
    this.workspaceRegistrations = new WorkspaceRegistrationDeleter(ctx.workspaceRegistry)
  }

  /** List all currently archived sessions with display metadata. */
  @Remote('list')
  async list(): Promise<ArchivedSessionListResult> {
    const items = await this.collectItems()
    items.sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    return { items, capabilities: this.capabilities() }
  }

  /**
   * Stored-session headers by id, from whichever listing surface this runtime
   * ships: `listSnapshots()` through rc.8, `list()` (whose snapshots carry the
   * same `header`) from 0.1.5 on. Headers are the listing's hard dependency —
   * a runtime exposing neither cannot render a single row, so that case is a
   * named error instead of a silently empty list.
   */
  private async readHeaders(): Promise<ReadonlyMap<string, SessionHeader>> {
    const persistence = this.ctx.sessionPersistence
    const snapshots = typeof persistence.listSnapshots === 'function'
      ? await persistence.listSnapshots()
      : typeof persistence.list === 'function'
        ? await persistence.list()
        : undefined
    if (snapshots === undefined) {
      throw new Error(
        'archived-sessions: this DSH runtime exposes neither SessionPersistence.listSnapshots nor SessionPersistence.list',
      )
    }
    return new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot.header]))
  }

  /**
   * One stored session's event log through whichever read surface this runtime
   * ships: `readFrom(id, 0)` through rc.8, `open(id, 'read')` plus a read
   * handle from 0.1.5 on. A runtime with neither yields no events; the caller
   * already renders that as a header-only row.
   *
   * Both calls go through the service instance, never through a detached
   * reference: every read surface is a real method that touches `this` (the
   * shipped JSONL backend's `open()` starts with `this.ensureRootEncoding()`),
   * so extracting it first would throw into the caller's header-only fallback
   * and silently strip the title and last-activity of every cold row.
   */
  private async readEvents(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    const persistence = this.ctx.sessionPersistence
    if (typeof persistence.readFrom === 'function') {
      return (await persistence.readFrom(sessionId, 0)).events
    }
    if (typeof persistence.open !== 'function') return []
    const handle = await persistence.open(sessionId, 'read')
    try {
      return (await handle.read(0)).events
    } finally {
      await handle.close()
    }
  }

  /**
   * Header-only rows for every archived session, shared by list and
   * deleteWorkspace.
   *
   * No stored log is read here: one cold read costs a full storage scan plus a
   * whole-log decode per session, so folding every row would make the listing
   * scale with the archive size (minutes for a thousand archived sessions). A
   * resident session's events are already in memory, so those rows arrive
   * complete; every other row is filled in later through {@link details} for
   * the ids a client actually displays.
   */
  private async collectItems(): Promise<ArchivedSessionItem[]> {
    const ctx = this.ctx
    const ids = [...ctx.workspaceRegistry.archivedSessionIds]

    const headers = await this.readHeaders()
    const workspaces = ctx.workspaceRegistry.list()

    const items: ArchivedSessionItem[] = []
    for (const sessionId of ids) {
      const live = ctx.sessions.get(sessionId)
      const header = live?.header ?? headers.get(sessionId)
      if (header === undefined) continue
      const running = ctx.agents.get(sessionId)?.status === 'running'
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(sessionId))
      items.push(item(
        sessionId,
        header,
        live === undefined ? undefined : liveSessionEvents(live),
        running,
        workspace === undefined ? undefined : {
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
        },
      ))
    }
    return items
  }

  /**
   * One row's events for a details request: a resident session's in-memory
   * events, otherwise its stored log. An unreadable log yields `undefined` and
   * is logged — the row keeps its header-only values instead of failing the
   * whole request.
   */
  private async readRowEvents(sessionId: SessionId): Promise<readonly SessionEvent[] | undefined> {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) return liveSessionEvents(live)
    try {
      return await this.readEvents(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `archived-sessions: could not read "${sessionId}" for details (serving header-only): ${String(error)}`,
      )
      return undefined
    }
  }

  /**
   * Fold `title` / `lastActivityAt` for the requested archived sessions only.
   *
   * The client asks for the rows it renders (an expanded group, one revealed
   * batch, or the whole set while searching), so the listing above stays free
   * of log reads and a large archive only pays for what is on screen. Ids
   * outside the archive set are ignored: this Remote is reachable by any
   * client and hydration reads durable logs.
   */
  @Remote('details')
  async details(request: ArchivedSessionsDetailsRequest): Promise<ArchivedSessionsDetailsResult> {
    const archived = new Set<string>(this.ctx.workspaceRegistry.archivedSessionIds as readonly string[])
    const ids = [...new Set(request.sessionIds)].filter(id => archived.has(id))
    const items: ArchivedSessionDetail[] = new Array<ArchivedSessionDetail>(ids.length)
    let cursor = 0
    const hydrate = async (): Promise<void> => {
      while (cursor < ids.length) {
        const index = cursor++
        const id = ids[index]!
        const events = await this.readRowEvents(SessionId(id))
        items[index] = events === undefined
          ? { sessionId: id, title: fallbackTitle(id), lastActivityAt: 0, detailsLoaded: false }
          : { sessionId: id, title: deriveTitle(events, id), lastActivityAt: sessionLastActivity(events), detailsLoaded: true }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(DETAILS_READ_CONCURRENCY, ids.length) }, () => hydrate()),
    )
    return { items }
  }

  /** Which runtime paths back restore, permanent delete and registration removal. */
  private capabilities(): ArchivedSessionsCapabilities {
    return {
      restore: this.archiveAdapter.getRestoreCapability(),
      // `native` here means "the Host can remove the durable log", not "the
      // runtime ships a delete API" — no released DSH ships one. The JSONL
      // backend's artifact-position surfaces are what make removal possible.
      delete: this.sessionLogs.getDeleteCapability() === 'unsupported' ? 'unsupported' : 'native',
      workspaceDelete: this.workspaceRegistrations.getDeleteCapability(),
    }
  }

  /**
   * Restore one archived session to its original workspace slot. Unsupported
   * runtimes receive a `restore-unsupported` domain result — never an
   * exception — so the client can render the capability gap inline.
   */
  @Remote('restore')
  async restore(request: ArchivedSessionRestoreRequest): Promise<ArchivedSessionRestoreValue> {
    const sessionId = SessionId(request.sessionId)
    if (this.archiveAdapter.getRestoreCapability() === 'unsupported') {
      return {
        code: 'restore-unsupported',
        sessionId: request.sessionId,
        message: 'restore is unavailable on this DSH runtime',
      }
    }
    await this.archiveAdapter.restore(sessionId)
    return { restored: true }
  }

  /**
   * Permanently delete one session and its durable history.
   *
   * The capability gate answers a domain result instead of throwing, so a
   * client that calls this on an unsupported runtime renders a capability gap
   * rather than a transport failure. The running/live preflight is repeated
   * here only to answer with the domain result; `deleteOne` owns the
   * authoritative check.
   */
  @Remote('delete')
  async delete(request: ArchivedSessionDeleteRequest): Promise<ArchivedSessionDeleteValue> {
    const sessionId = SessionId(request.sessionId)
    if (this.sessionLogs.getDeleteCapability() === 'unsupported') {
      return {
        code: 'delete-unsupported',
        sessionId: request.sessionId,
        message: 'permanent delete is unavailable on this DSH runtime',
      }
    }
    if (this.ctx.agents.get(sessionId)?.status === 'running'
      || this.ctx.sessions.get(sessionId) !== undefined) {
      return this.runningError(request.sessionId)
    }
    try {
      await this.deleteOne(sessionId)
    } catch (error: unknown) {
      // Second protection: the session may have become running/live after the
      // check above and before deleteOne inspected it.
      if (isLiveDeleteError(error)) {
        return this.runningError(request.sessionId)
      }
      if (error instanceof SessionNotFoundError) {
        return {
          code: 'session-not-found',
          sessionId: request.sessionId,
          message: error.message,
        }
      }
      throw error
    }
    return { deleted: true }
  }

  /**
   * Shared single-session irreversible delete used by delete, deleteWorkspace
   * and deleteWorkspaceRegistration's group cleanup.
   *
   * The order is deliberately: (1) preflight — archived membership + not
   * running/live; (2) remove the durable log artifacts; (3) detach every
   * workspace accounting slot; (4) remove the archive-set entry. Bookkeeping
   * never pretends success before the durable removal has committed, and the
   * archive-set entry is dropped last so a failed removal leaves the row
   * visible and retryable instead of orphaning a session the archive set no
   * longer knows about.
   *
   * The live check is not cosmetic: the JSONL backend reopens a session's log
   * by path on every append, so removing the log of a session that still has a
   * writer recreates a headerless file on the next batch — "deleted" would
   * become "corrupt", which is worse than refusing.
   */
  private async deleteOne(sessionId: SessionId): Promise<void> {
    const ctx = this.ctx
    if (!ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
      throw new SessionNotFoundError(sessionId as string)
    }
    if (ctx.agents.get(sessionId)?.status === 'running' || ctx.sessions.get(sessionId) !== undefined) {
      // Never dispose a running Agent or force-remove a live Session to make
      // room for a delete; the user must stop/archive it first.
      throw new SessionRunningError(sessionId as string)
    }

    // The header carries the id and cwd the backend derives its artifact path
    // from, so a stored header is what makes the locate() fallback possible.
    const header = (await this.readHeaders()).get(sessionId)
    await this.sessionLogs.remove(sessionId, header)

    for (const workspace of ctx.workspaceRegistry.list()) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error: unknown) {
        ctx.logger.warn(
          `archived-sessions: workspace "${workspace.id}" could not detach deleted session "${sessionId}": ${String(error)}`,
        )
      }
    }

    try {
      // Same archive-set primitive as restore (native or rc.6 path).
      await this.archiveAdapter.removeFromArchiveSet(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(
        `archived-sessions: deleted session "${sessionId}" could not be removed from the archive set: ${String(error)}`,
      )
    }
  }

  /**
   * Permanently deletes all archived sessions in one archived-session
   * workspace group.
   *
   * Does NOT delete the DSH Workspace registration or project directory; that
   * is a separate action on {@link deleteWorkspaceRegistration}, so neither
   * button can silently do the other's job.
   *
   * workspaceId omitted means the Unknown Workspace / Ungrouped group.
   */
  @Remote('deleteWorkspace')
  async deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<ArchivedWorkspaceDeleteValue> {
    const ctx = this.ctx
    const workspaceId = request.workspaceId

    if (this.sessionLogs.getDeleteCapability() === 'unsupported') {
      return {
        code: 'workspace-delete-unsupported',
        workspaceId,
        message: 'permanent delete is unavailable on this DSH runtime',
      }
    }

    const items = (await this.collectItems()).filter(item =>
      workspaceId === undefined ? item.workspaceId === undefined : item.workspaceId === workspaceId,
    )
    // Preflight the whole group BEFORE deleting anything: one running/live
    // session aborts the entire batch with no partial deletion.
    const blocked = items.filter(item => {
      const id = SessionId(item.sessionId)
      return item.running || ctx.agents.get(id)?.status === 'running' || ctx.sessions.get(id) !== undefined
    })
    if (blocked.length > 0) {
      const firstBlocked = blocked[0]!
      return {
        code: 'workspace-sessions-running',
        workspaceId,
        runningSessionCount: blocked.length,
        sessionId: firstBlocked.sessionId,
        title: await this.rowTitle(firstBlocked.sessionId, firstBlocked.title),
        message: `cannot delete workspace group: ${blocked.length} session(s) are running/live`,
      }
    }

    let deletedCount = 0
    for (const item of items) {
      const id = SessionId(item.sessionId)
      // Re-check inside the loop too: a session that was cold during preflight
      // may have become running/live while earlier sessions were deleting.
      if (ctx.agents.get(id)?.status === 'running' || ctx.sessions.get(id) !== undefined) {
        if (deletedCount === 0) {
          return {
            code: 'workspace-sessions-running',
            workspaceId,
            runningSessionCount: 1,
            sessionId: item.sessionId,
            title: await this.rowTitle(item.sessionId, item.title),
            message: `cannot delete workspace group: session "${item.sessionId}" became running`,
          }
        }
        return {
          code: 'workspace-delete-partial',
          workspaceId,
          deletedCount,
          failedSessionId: item.sessionId,
          message: `deleted ${deletedCount} session(s) before aborting because "${item.sessionId}" became running`,
        }
      }
      try {
        await this.deleteOne(id)
        deletedCount++
      } catch (error: unknown) {
        ctx.logger.warn(
          `archived-sessions: deleteWorkspace stopped after ${deletedCount} deletion(s); failed on "${item.sessionId}": ${String(error)}`,
        )
        if (isLiveDeleteError(error) && deletedCount === 0) {
          // A running session slipped past the loop re-check but deleteOne's
          // own guard caught it before anything was deleted.
          return {
            code: 'workspace-sessions-running',
            workspaceId,
            runningSessionCount: 1,
            sessionId: item.sessionId,
            title: await this.rowTitle(item.sessionId, item.title),
            message: `cannot delete workspace group: session "${item.sessionId}" became running`,
          }
        }
        return {
          code: 'workspace-delete-partial',
          workspaceId,
          deletedCount,
          failedSessionId: item.sessionId,
          message: `deleted ${deletedCount} session(s) before failing on "${item.sessionId}": ${String(error)}`,
        }
      }
    }

    return { deleted: true, deletedCount }
  }

  /**
   * Removes one DSH Workspace registration from the workspace list.
   *
   * This is the official `WorkspaceRegistry.delete(id)` semantics and is
   * deliberately non-destructive: the registration and its position in the
   * durable display order go away, while the directory, its files and every
   * session log are retained. Sessions that belonged to it fall back to
   * Ungrouped, and any of them still in the registry-global archive set keep
   * their archive entry — that is why this endpoint touches the archive set
   * not at all, and why the UI keeps "clear this group's archived sessions"
   * as a separate action.
   *
   * Not idempotent-by-error: an unknown id resolves as `workspace-not-found`
   * (the requested end state already holds) instead of an exception.
   */
  @Remote('deleteWorkspaceRegistration')
  async deleteWorkspaceRegistration(
    request: ArchivedWorkspaceRegistrationDeleteRequest,
  ): Promise<ArchivedWorkspaceRegistrationDeleteValue> {
    const workspaceId = request.workspaceId
    if (this.workspaceRegistrations.getDeleteCapability() === 'unsupported') {
      return {
        code: 'workspace-registration-delete-unsupported',
        workspaceId,
        message: 'removing a Workspace registration is unavailable on this DSH runtime',
      }
    }
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      // An empty or absent id can never name a registration; answering
      // `not-found` keeps the client from reporting a removal it did not
      // perform (the ungrouped group has no registration to remove).
      return {
        code: 'workspace-not-found',
        workspaceId,
        message: 'cannot remove a Workspace registration without a workspace id',
      }
    }
    const deleted = await this.workspaceRegistrations.remove(workspaceId)
    if (!deleted) {
      return {
        code: 'workspace-not-found',
        workspaceId,
        message: `cannot remove workspace "${workspaceId}": no such Workspace registration`,
      }
    }
    return { deleted: true, workspaceId }
  }

  /**
   * The title a user-facing message should name one row by: the folded title
   * when the log is readable, the row's own value otherwise. Rows arrive
   * header-only from {@link collectItems}, and the few rows a refusal names are
   * worth hydrating so the message does not read like a placeholder.
   */
  private async rowTitle(sessionId: string, fallback: string): Promise<string> {
    const events = await this.readRowEvents(SessionId(sessionId))
    return events === undefined ? fallback : deriveTitle(events, sessionId)
  }

  private runningError(sessionId: string): ArchivedSessionRunningError {
    return {
      code: 'session-running',
      sessionId,
      message: `cannot delete session "${sessionId}": session is running`,
    }
  }
}

export default ArchivedSessionsService

export type { ArchivedSessionItem, ArchivedSessionDeleteValue } from './types.ts'
