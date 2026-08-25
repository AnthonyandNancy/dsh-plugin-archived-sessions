/**
 * Archived Sessions plugin Host half.
 *
 * Exposes the official DSH Typert Remote API consumed by the Settings page:
 * list archived sessions, restore one, and permanently delete one. Restore is
 * routed through the plugin's own {@link ArchiveCompatibilityAdapter}, which
 * capability-detects the runtime — the official
 * `WorkspaceRegistry.unarchiveSession` when it exists, the rc.6
 * `enqueueOperation` / `requireState` / `setState` mutation surface
 * otherwise — so the service starts on every DSH build and degrades to a
 * `restore-unsupported` domain result only where no path exists. Deletion
 * reuses first-party orchestration primitives (`SessionPersistence.delete`,
 * `AgentLoop.disposeAgent`, workspace detach) and routes the archive-set
 * cleanup through the same adapter primitive. The plugin never touches
 * session files directly.
 *
 * @module dsh-plugin-archived-sessions
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ArchiveCompatibilityAdapter } from './host/compat/restore.ts'
import type {
  ArchivedSessionDeleteRequest,
  ArchivedSessionDeleteValue,
  ArchivedSessionItem,
  ArchivedSessionListResult,
  ArchivedSessionRestoreRequest,
  ArchivedSessionRestoreValue,
  ArchivedSessionsCapabilities,
} from './types.ts'
import type { ArchivedSessionRunningError } from './types.ts'
import type {
  ArchivedWorkspaceDeleteRequest,
  ArchivedWorkspaceDeleteValue,
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
 * `unarchiveSession` is intentionally optional: rc.6 runtimes expose only the
 * archive set and their internal mutation path, which the compatibility
 * adapter probes at runtime.
 */
interface ArchivedWorkspaceRegistry {
  archivedSessionIds: readonly SessionId[]
  list(): readonly ArchivedWorkspace[]
  unarchiveSession?(sessionId: SessionId): Promise<void>
}

/**
 * Minimal durable-session-persistence surface used by the archived-sessions
 * host. `delete` is optional because older runtimes may lack the
 * orchestration; when absent, delete capability reports `unsupported` and
 * the plugin keeps running.
 */
interface ArchivedSessionPersistence {
  listSnapshots(): Promise<readonly { header: SessionHeader }[]>
  readFrom(sessionId: SessionId, offset: number): Promise<{ events: readonly SessionEvent[] }>
  delete?(sessionId: SessionId, signal?: AbortSignal): Promise<void>
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
      get(sessionId: SessionId): { header: SessionHeader; events: readonly SessionEvent[] } | undefined
    }
  }
}

/** Cap for the fallback title text derived from a first user message. */
const FALLBACK_TITLE_MAX_CHARS = 48

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
  return `会话 ${sessionId.slice(0, 8)}`
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

/** One archived session's display row. */
function item(
  sessionId: string,
  header: SessionHeader,
  events: readonly SessionEvent[],
  running: boolean,
  workspace: { id: string; title: string; path: string } | undefined,
): ArchivedSessionItem {
  return {
    sessionId,
    title: deriveTitle(events, sessionId),
    ...(workspace === undefined ? {} : {
      workspaceId: workspace.id,
      workspaceTitle: workspace.title,
      workspacePath: workspace.path,
    }),
    createdAt: header.createdAt,
    lastActivityAt: sessionUpdatedAt(header, events),
    running,
  }
}

/**
 * Host Remote service for the archived-sessions manager.
 */
export class ArchivedSessionsService extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents']

  private readonly archiveAdapter: ArchiveCompatibilityAdapter

  constructor(ctx: Context) {
    // No startup capability gate: the adapter detects the runtime shape
    // (official `unarchiveSession`, rc.6 mutation surface, or neither) and
    // the service degrades to domain results where a capability is missing.
    super(ctx, 'archivedSessions')
    this.archiveAdapter = new ArchiveCompatibilityAdapter(ctx.workspaceRegistry)
  }

  /** List all currently archived sessions with display metadata. */
  @Remote('list')
  async list(): Promise<ArchivedSessionListResult> {
    const items = await this.collectItems()
    items.sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    return { items, capabilities: this.capabilities() }
  }

  /** Build the unsorted archived-session rows shared by list and deleteWorkspace. */
  private async collectItems(): Promise<ArchivedSessionItem[]> {
    const ctx = this.ctx
    const ids = [...ctx.workspaceRegistry.archivedSessionIds]

    const snapshots = await ctx.sessionPersistence.listSnapshots()
    const headers = new Map<string, SessionHeader>(
      snapshots.map(snapshot => [snapshot.header.id, snapshot.header]),
    )
    const workspaces = ctx.workspaceRegistry.list()

    const items: ArchivedSessionItem[] = []
    for (const sessionId of ids) {
      const live = ctx.sessions.get(sessionId)
      const header = live?.header ?? headers.get(sessionId)
      if (header === undefined) continue
      const events = live?.events ?? []
      let resolvedEvents = events
      if (live === undefined) {
        try {
          const inspection = await ctx.sessionPersistence.readFrom(sessionId, 0)
          resolvedEvents = inspection.events
        } catch (error) {
          ctx.logger.warn(
            `archived-sessions: could not read "${sessionId}" for listing (serving header-only): ${String(error)}`,
          )
        }
      }
      const running = ctx.agents.get(sessionId)?.status === 'running'
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(sessionId))
      items.push(item(
        sessionId,
        header,
        resolvedEvents,
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

  /** Which runtime paths back restore and permanent delete. */
  private capabilities(): ArchivedSessionsCapabilities {
    return {
      restore: this.archiveAdapter.getRestoreCapability(),
      delete: typeof this.ctx.sessionPersistence.delete === 'function' ? 'native' : 'unsupported',
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

  /** Permanently delete one session and its durable history. */
  @Remote('delete')
  async delete(request: ArchivedSessionDeleteRequest): Promise<ArchivedSessionDeleteValue> {
    const ctx = this.ctx
    const sessionId = SessionId(request.sessionId)

    if (typeof ctx.sessionPersistence.delete !== 'function') {
      return {
        code: 'delete-unsupported',
        sessionId: request.sessionId,
        message: 'permanent delete is unavailable on this DSH runtime',
      }
    }

    const agent = ctx.agents.get(sessionId)
    if (agent?.status === 'running') {
      return this.runningError(request.sessionId)
    }

    await this.deleteOne(sessionId)
    return { deleted: true }
  }

  /** Shared single-session irreversible delete used by delete and deleteWorkspace. */
  private async deleteOne(sessionId: SessionId): Promise<void> {
    const ctx = this.ctx
    const agent = ctx.agents.get(sessionId)
    const liveSession = ctx.sessions.get(sessionId)
    if (liveSession !== undefined && agent === undefined) {
      throw new Error(
        `archived-sessions: cannot delete live session "${sessionId}" because no live agent handle is available to detach it`,
      )
    }

    if (agent !== undefined) {
      const agentLoop = ctx.get('agentLoop') as
        | { disposeAgent(id: SessionId): Promise<boolean> }
        | undefined
      if (agentLoop === undefined) {
        throw new Error(
          `archived-sessions: cannot delete live session "${sessionId}" because the agent loop is not available`,
        )
      }
      await agentLoop.disposeAgent(sessionId)
    }

    const deleteSession = ctx.sessionPersistence.delete
    if (deleteSession === undefined) {
      throw new Error('archived-sessions: sessionPersistence.delete disappeared between capability check and delete')
    }
    await deleteSession(sessionId)

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

  /** Permanently delete every archived session in one workspace group. */
  @Remote('deleteWorkspace')
  async deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<ArchivedWorkspaceDeleteValue> {
    const ctx = this.ctx
    const workspaceId = request.workspaceId

    if (typeof ctx.sessionPersistence.delete !== 'function') {
      return {
        code: 'workspace-delete-unsupported',
        workspaceId,
        message: 'permanent delete is unavailable on this DSH runtime',
      }
    }

    const items = (await this.collectItems()).filter(item =>
      workspaceId === undefined ? item.workspaceId === undefined : item.workspaceId === workspaceId,
    )
    const running = items.filter(item => item.running)
    if (running.length > 0) {
      return {
        code: 'workspace-sessions-running',
        workspaceId,
        runningSessionCount: running.length,
        message: `cannot delete workspace group: ${running.length} session(s) are running`,
      }
    }

    let deletedCount = 0
    for (const item of items) {
      try {
        await this.deleteOne(SessionId(item.sessionId))
        deletedCount++
      } catch (error: unknown) {
        ctx.logger.warn(
          `archived-sessions: deleteWorkspace stopped after ${deletedCount} deletion(s); failed on "${item.sessionId}": ${String(error)}`,
        )
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
