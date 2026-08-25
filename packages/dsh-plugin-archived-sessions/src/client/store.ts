/**
 * Archived Sessions client store: a small external store fed by the Host
 * Remote API for listing / restore / deletion. It keeps the full fetched list
 * in memory. Session reveal / per-project expansion is presentation state
 * owned by the UI, not by the store.
 *
 * Refresh is split into a full first load (`status: 'loading'`) and quiet
 * background refreshes (`refreshing: true`): once rows are on screen, a
 * workspace archive event re-fetches without flashing the page back into a
 * loading state, and a background failure keeps showing the current rows.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ArchivedSessionDeleteRequest,
  ArchivedSessionDeleteValue,
  ArchivedSessionItem,
  ArchivedSessionListResult,
  ArchivedSessionRestoreRequest,
  ArchivedSessionRestoreValue,
  ArchivedSessionsCapabilities,
  ArchivedWorkspaceDeleteRequest,
  ArchivedWorkspaceDeleteValue,
} from '../types.ts'

export type ArchivedSort = 'lastActivity' | 'createdAt'

export interface ArchivedSessionsState {
  readonly status: 'loading' | 'ready' | 'error'
  /** True while a background refresh is in flight after the first load. */
  readonly refreshing: boolean
  /** Full fetched list; the UI derives all workspace groups from this. */
  readonly items: readonly ArchivedSessionItem[]
  readonly error: string | null
  readonly filter: string
  readonly sort: ArchivedSort
  /** Host-detected runtime paths; gates the restore / delete buttons. */
  readonly capabilities: ArchivedSessionsCapabilities
}

/** Minimal structural Remote face used by the store (avoids a hard import of generated d.ts here). */
export interface ArchivedSessionsRemote {
  list(): Promise<RemoteResult<ArchivedSessionListResult>>
  restore(request: ArchivedSessionRestoreRequest): Promise<RemoteResult<ArchivedSessionRestoreValue>>
  delete(request: ArchivedSessionDeleteRequest): Promise<RemoteResult<ArchivedSessionDeleteValue>>
  deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<RemoteResult<ArchivedWorkspaceDeleteValue>>
}

const INITIAL_STATE: ArchivedSessionsState = {
  status: 'loading',
  refreshing: false,
  items: [],
  error: null,
  filter: '',
  sort: 'lastActivity',
  capabilities: { restore: 'unsupported', delete: 'unsupported' },
}

export class ArchivedSessionsStore {
  private state: ArchivedSessionsState = INITIAL_STATE
  private readonly listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | undefined
  private readonly remote: ArchivedSessionsRemote

  constructor(remote: ArchivedSessionsRemote) {
    this.remote = remote
  }

  getSnapshot = (): ArchivedSessionsState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setFilter(filter: string): void {
    this.state = { ...this.state, filter }
    this.emit()
  }

  setSort(sort: ArchivedSort): void {
    this.state = { ...this.state, sort }
    this.emit()
  }

  refresh(): Promise<void> {
    this.refreshPromise ??= this.doRefresh().finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }

  /**
   * Restore a session through the Host Remote, then remove it from the local
   * list only after the Host confirms (pessimistic). No full reload is
   * issued, so scroll position and expanded/reveal UI state are preserved; a
   * later archive-set snapshot refresh converges to the same final state.
   */
  async restore(sessionId: string): Promise<void> {
    const result = await this.remote.restore({ sessionId })
    if (!result.ok) throw new Error(result.error.message)
    if ('restored' in result.value) {
      this.removeById(sessionId)
      return
    }
    // `restore-unsupported` is a domain result, surfaced as a normal error.
    throw new Error(result.value.message)
  }

  async delete(sessionId: string): Promise<void> {
    const result = await this.remote.delete({ sessionId })
    if (!result.ok) throw new Error(result.error.message)
    if ('deleted' in result.value) {
      this.removeById(sessionId)
      return
    }
    throw new Error(result.value.message)
  }

  /**
   * Permanently delete every archived session in one workspace group, then
   * remove the whole group from the local list after the Host confirms.
   * `workspaceId` omitted targets ungrouped sessions (未知工作区).
   */
  async deleteWorkspace(workspaceId?: string): Promise<void> {
    const result = await this.remote.deleteWorkspace(workspaceId === undefined ? {} : { workspaceId })
    if (!result.ok) throw new Error(result.error.message)
    if ('deleted' in result.value) {
      this.removeByWorkspace(workspaceId)
      return
    }
    const error = new Error(result.value.message)
    Object.assign(error, result.value)
    if (result.value.code === 'workspace-delete-partial') {
      try {
        await this.refresh()
      } catch {
        // Keep the original partial-delete error; refresh failure must not mask it.
      }
    }
    throw error
  }

  /** Drop every item that belongs to one workspace group. */
  removeByWorkspace(workspaceId: string | undefined): void {
    const items = workspaceId === undefined
      ? this.state.items.filter(item => item.workspaceId !== undefined)
      : this.state.items.filter(item => item.workspaceId !== workspaceId)
    if (items.length === this.state.items.length) return
    this.state = {
      ...this.state,
      items,
    }
    this.emit()
  }

  /** Idempotently drop one id from the local list. */
  removeById(sessionId: string): void {
    const items = this.state.items.filter(item => item.sessionId !== sessionId)
    if (items.length === this.state.items.length) return
    this.state = {
      ...this.state,
      items,
    }
    this.emit()
  }

  private async doRefresh(): Promise<void> {
    // First load (no rows yet, not previously ready) may show the full
    // loading state; once anything was rendered, a refresh is quiet and
    // keeps `status: 'ready'`, `items`, `filter`, `sort`.
    const firstLoad = this.state.items.length === 0 && this.state.status !== 'ready'
    this.state = {
      ...this.state,
      status: firstLoad ? 'loading' : 'ready',
      refreshing: !firstLoad,
      error: null,
    }
    this.emit()
    try {
      const result = await this.remote.list()
      if (!result.ok) throw new Error(result.error.message)
      this.state = {
        ...this.state,
        status: 'ready',
        refreshing: false,
        items: result.value.items,
        capabilities: result.value.capabilities,
        error: null,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      // Keep showing already-fetched rows on a background failure; only a
      // first load with nothing to show enters the error state.
      this.state = {
        ...this.state,
        status: this.state.items.length > 0 ? 'ready' : 'error',
        refreshing: false,
        error: message,
      }
    } finally {
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
