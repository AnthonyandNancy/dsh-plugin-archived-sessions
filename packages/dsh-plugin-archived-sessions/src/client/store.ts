/**
 * Archived Sessions client store: a small external store fed by the Host
 * Remote API for listing/deletion and by the official Workspace runtime for
 * restore. It keeps the full fetched list in memory and exposes an
 * append-only `loadedCount` cursor so infinite scroll never replaces already
 * rendered rows.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ArchivedSessionDeleteRequest,
  ArchivedSessionDeleteValue,
  ArchivedSessionItem,
  ArchivedSessionListResult,
} from '../types.ts'

export type ArchivedSort = 'lastActivity' | 'createdAt'

export interface ArchivedSessionsState {
  readonly status: 'loading' | 'ready' | 'error'
  /** Full fetched list; the UI renders `items.slice(0, loadedCount)`. */
  readonly items: readonly ArchivedSessionItem[]
  /** Number of rows currently revealed by infinite scroll. */
  readonly loadedCount: number
  readonly error: string | null
  readonly filter: string
  readonly sort: ArchivedSort
}

/** Minimal structural Remote face used by the store (avoids a hard import of generated d.ts here). */
export interface ArchivedSessionsRemote {
  list(): Promise<RemoteResult<ArchivedSessionListResult>>
  delete(request: ArchivedSessionDeleteRequest): Promise<RemoteResult<ArchivedSessionDeleteValue>>
}

export const ARCHIVED_SESSIONS_PAGE_SIZE = 20

const INITIAL_STATE: ArchivedSessionsState = {
  status: 'loading',
  items: [],
  loadedCount: ARCHIVED_SESSIONS_PAGE_SIZE,
  error: null,
  filter: '',
  sort: 'lastActivity',
}

export class ArchivedSessionsStore {
  private state: ArchivedSessionsState = INITIAL_STATE
  private readonly listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | undefined

  constructor(
    private readonly remote: ArchivedSessionsRemote,
    private readonly restoreSession: (sessionId: string) => Promise<void>,
  ) {}

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

  loadMore(): void {
    const next = Math.min(this.state.loadedCount + ARCHIVED_SESSIONS_PAGE_SIZE, this.state.items.length)
    if (next === this.state.loadedCount) return
    this.state = { ...this.state, loadedCount: next }
    this.emit()
  }

  /**
   * Restore a session through the official Workspace API, then remove it from
   * the local list only after the Host confirms success (pessimistic). No full
   * reload is issued, so scroll position and loaded pages are preserved.
   */
  async restore(sessionId: string): Promise<void> {
    await this.restoreSession(sessionId)
    this.removeById(sessionId)
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

  /** Idempotently drop one id from the local list and keep the loaded cursor stable. */
  removeById(sessionId: string): void {
    const items = this.state.items.filter(item => item.sessionId !== sessionId)
    if (items.length === this.state.items.length) return
    this.state = {
      ...this.state,
      items,
      loadedCount: Math.min(this.state.loadedCount, items.length),
    }
    this.emit()
  }

  private async doRefresh(): Promise<void> {
    this.state = { ...this.state, status: 'loading', error: null }
    this.emit()
    try {
      const result = await this.remote.list()
      if (!result.ok) throw new Error(result.error.message)
      this.state = {
        ...this.state,
        status: 'ready',
        items: result.value.items,
        loadedCount: Math.min(this.state.loadedCount, result.value.items.length),
        error: null,
      }
    } catch (error: unknown) {
      this.state = {
        ...this.state,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
