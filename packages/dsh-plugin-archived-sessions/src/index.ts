/**
 * Archived Sessions plugin Host half.
 *
 * Exposes the official DSH Typert Remote API consumed by the Settings page:
 * list archived sessions and permanently delete one. Restore is intentionally
 * routed through the official `ctx.workspaces.restoreSession` client API (Host
 * `workspace.restoreSession` → `WorkspaceRegistry.unarchiveSession`), never
 * through a plugin-private registry reach. Deletion reuses the first-party
 * orchestration primitives added to upstream DSH
 * (`SessionPersistence.delete`, `AgentLoop.disposeAgent`, and the workspace
 * registry's unarchive/detach operations) — the plugin never touches session
 * files directly.
 *
 * @module dsh-plugin-archived-sessions
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ArchivedSessionDeleteRequest,
  ArchivedSessionDeleteValue,
  ArchivedSessionItem,
  ArchivedSessionListResult,
} from './types.ts'
import type { ArchivedSessionRunningError } from './types.ts'

/** Minimal workspace shape used by the archived-sessions host surface. */
interface ArchivedWorkspace {
  id: string
  title: string
  path: string
  sessionIds: readonly SessionId[]
  detachSession(sessionId: SessionId): Promise<void> | void
}

/** Minimal workspace-registry surface used by the archived-sessions host. */
interface ArchivedWorkspaceRegistry {
  archivedSessionIds: readonly SessionId[]
  list(): readonly ArchivedWorkspace[]
  unarchiveSession(sessionId: SessionId): Promise<void>
}

/** Minimal durable-session-persistence surface used by the archived-sessions host. */
interface ArchivedSessionPersistence {
  listSnapshots(): Promise<readonly { header: SessionHeader }[]>
  readFrom(sessionId: SessionId, offset: number): Promise<{ events: readonly SessionEvent[] }>
  delete(sessionId: SessionId, signal?: AbortSignal): Promise<void>
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

  constructor(ctx: Context) {
    // Fail at startup on DSH builds that predate the upstream unarchive
    // capability. The client half has a matching check; this protects the
    // host half (including delete cleanup) from calling a missing method.
    if (typeof ctx.workspaceRegistry.unarchiveSession !== 'function') {
      throw new Error(
        'archived-sessions: incompatible DSH version — WorkspaceRegistry.unarchiveSession '
        + '/ workspace.restoreSession is unavailable. Upgrade DSH to the minimum version '
        + 'documented in the plugin README.',
      )
    }
    super(ctx, 'archivedSessions')
  }

  /** List all currently archived sessions with display metadata. */
  @Remote('list')
  async list(): Promise<ArchivedSessionListResult> {
    const ctx = this.ctx
    const ids = [...ctx.workspaceRegistry.archivedSessionIds]

    // Cheap header index first; live sessions overlay it (a brand-new session
    // can be archived before its first durable snapshot lands).
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

    // Default server-side order is by last activity, newest first; the client
    // may re-sort locally without another round trip.
    items.sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    return { items }
  }

  /** Permanently delete one session and its durable history. */
  @Remote('delete')
  async delete(request: ArchivedSessionDeleteRequest): Promise<ArchivedSessionDeleteValue> {
    const ctx = this.ctx
    const sessionId = SessionId(request.sessionId)

    const agent = ctx.agents.get(sessionId)
    if (agent?.status === 'running') {
      return this.runningError(request.sessionId)
    }

    const liveSession = ctx.sessions.get(sessionId)
    if (liveSession !== undefined && agent === undefined) {
      throw new Error(
        `archived-sessions: cannot delete live session "${request.sessionId}" because no live agent handle is available to detach it`,
      )
    }

    // Dispose a live idle agent first so the in-memory Session is detached
    // before its durable log is removed.
    if (agent !== undefined) {
      const agentLoop = ctx.get('agentLoop') as
        | { disposeAgent(id: SessionId): Promise<boolean> }
        | undefined
      if (agentLoop === undefined) {
        throw new Error(
          `archived-sessions: cannot delete live session "${request.sessionId}" because the agent loop is not available`,
        )
      }
      await agentLoop.disposeAgent(sessionId)
    }

    // The persistence delete is the authoritative irreversible step. Once it
    // commits, workspace/archive cleanup is best-effort so a cleanup failure
    // cannot report the deletion as failed after the data is gone.
    await ctx.sessionPersistence.delete(sessionId)

    for (const workspace of ctx.workspaceRegistry.list()) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error: unknown) {
        ctx.logger.warn(
          `archived-sessions: workspace "${workspace.id}" could not detach deleted session "${request.sessionId}": ${String(error)}`,
        )
      }
    }

    try {
      await ctx.workspaceRegistry.unarchiveSession(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(
        `archived-sessions: deleted session "${request.sessionId}" could not be removed from the archive set: ${String(error)}`,
      )
    }

    return { deleted: true }
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
