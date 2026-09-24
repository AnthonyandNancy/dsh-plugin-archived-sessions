/**
 * Archived Sessions client store: a small external store fed by the Host
 * Remote API for listing / restore / deletion. It keeps the full fetched list
 * in memory. Session reveal / per-project expansion is presentation state
 * owned by the UI, not by the store.
 *
 * The listing itself is header-only: reading every archived session's log
 * would make the page scale with the archive size, so a row's title and last
 * activity arrive through `loadDetails` for the ids the UI actually renders.
 * Hydrated values are cached here and re-applied to later listings, so a
 * workspace archive event never flashes already-known titles back to
 * placeholders.
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
  ArchivedSessionDetail,
  ArchivedSessionItem,
  ArchivedSessionListResult,
  ArchivedSessionRestoreRequest,
  ArchivedSessionRestoreValue,
  ArchivedSessionsCapabilities,
  ArchivedSessionsDetailsRequest,
  ArchivedSessionsDetailsResult,
  ArchivedWorkspaceDeleteRequest,
  ArchivedWorkspaceDeleteValue,
  ArchivedWorkspaceRegistrationDeleteRequest,
  ArchivedWorkspaceRegistrationDeleteValue,
} from '../types.ts'

export type ArchivedSort = 'lastActivity' | 'createdAt'

/**
 * How many rows one `details` Remote call asks for. The host caps its own read
 * concurrency, so this only trades round trips against progress granularity:
 * the UI re-renders (and reports progress) once per batch.
 */
const DETAILS_BATCH_SIZE = 64

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
  /** True while at least one `details` request is in flight. */
  readonly hydrating: boolean
  /** Failure of the last `details` request, kept separate from the list error. */
  readonly detailsError: string | null
}

/** Minimal structural Remote face used by the store (avoids a hard import of generated d.ts here). */
export interface ArchivedSessionsRemote {
  list(): Promise<RemoteResult<ArchivedSessionListResult>>
  details(request: ArchivedSessionsDetailsRequest): Promise<RemoteResult<ArchivedSessionsDetailsResult>>
  restore(request: ArchivedSessionRestoreRequest): Promise<RemoteResult<ArchivedSessionRestoreValue>>
  delete(request: ArchivedSessionDeleteRequest): Promise<RemoteResult<ArchivedSessionDeleteValue>>
  deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<RemoteResult<ArchivedWorkspaceDeleteValue>>
  deleteWorkspaceRegistration(
    request: ArchivedWorkspaceRegistrationDeleteRequest,
  ): Promise<RemoteResult<ArchivedWorkspaceRegistrationDeleteValue>>
}

/**
 * Outcome of a Workspace-registration removal.
 *
 * `not-found` is not an error — the registry treats an unknown id as an
 * idempotent no-op, so the requested end state already holds. The caller
 * still has to distinguish it to avoid claiming a removal it did not perform.
 */
export type WorkspaceRegistrationOutcome = 'deleted' | 'not-found'

const INITIAL_STATE: ArchivedSessionsState = {
  status: 'loading',
  refreshing: false,
  items: [],
  error: null,
  filter: '',
  sort: 'lastActivity',
  capabilities: { restore: 'unsupported', delete: 'unsupported', workspaceDelete: 'unsupported' },
  hydrating: false,
  detailsError: null,
}

export class ArchivedSessionsStore {
  private state: ArchivedSessionsState = INITIAL_STATE
  private readonly listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | undefined
  private readonly remote: ArchivedSessionsRemote
  /** Hydrated row values, keyed by session id; survives listings. */
  private readonly details = new Map<string, ArchivedSessionDetail>()
  /** Ids with a `details` request in flight, so repeat renders do not re-ask. */
  private readonly inFlight = new Set<string>()
  /** Ids whose log this host cannot read; asking again would repeat the failure. */
  private readonly unreadable = new Set<string>()

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
   * Fold `title` / `lastActivityAt` for the rows a caller is about to render.
   *
   * Ids already hydrated, already in flight, known unreadable, or absent from
   * the current listing are skipped, so the UI can call this on every render
   * with its visible ids. Rows are patched in place and the store emits once
   * per batch, which keeps scrolling and expanded groups stable.
   */
  async loadDetails(sessionIds: readonly string[]): Promise<void> {
    const loaded = new Set(this.state.items.filter(item => item.detailsLoaded).map(item => item.sessionId))
    const known = new Set(this.state.items.map(item => item.sessionId))
    const wanted: string[] = []
    for (const sessionId of sessionIds) {
      if (loaded.has(sessionId) || this.details.has(sessionId) || this.inFlight.has(sessionId)) continue
      if (this.unreadable.has(sessionId) || !known.has(sessionId)) continue
      this.inFlight.add(sessionId)
      wanted.push(sessionId)
    }
    if (wanted.length === 0) return

    this.state = { ...this.state, hydrating: true, detailsError: null }
    this.emit()
    try {
      for (let offset = 0; offset < wanted.length; offset += DETAILS_BATCH_SIZE) {
        const batch = wanted.slice(offset, offset + DETAILS_BATCH_SIZE)
        const result = await this.remote.details({ sessionIds: batch })
        if (!result.ok) throw new Error(result.error.message)
        this.applyDetails(result.value.items)
        this.emit()
      }
    } catch (error: unknown) {
      // Keep whatever arrived; the rows still pending stay placeholders and
      // keep their ids out of `inFlight` so a later render may retry them.
      const message = error instanceof Error ? error.message : String(error)
      this.state = { ...this.state, detailsError: message }
    } finally {
      for (const sessionId of wanted) this.inFlight.delete(sessionId)
      this.state = { ...this.state, hydrating: this.inFlight.size > 0 }
      this.emit()
    }
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
    const error = new Error(result.value.message)
    Object.assign(error, result.value)
    throw error
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
      // A concurrent workspace-archive refresh may already be in flight and
      // could have been issued before these deletions committed. Wait for it,
      // then run a fresh refresh so the local list converges.
      if (this.refreshPromise !== undefined) {
        try {
          await this.refreshPromise
        } catch {
          // Ignore the earlier refresh's failure; the fresh one below is what
          // reconciles this deletion result.
        }
      }
      try {
        await this.refresh()
      } catch {
        // Keep the original partial-delete error; refresh failure must not mask it.
      }
    }
    throw error
  }

  /**
   * Remove one DSH Workspace registration from the workspace list. The
   * directory, its files and every session log are retained; the archived rows
   * stay in this list and simply fall back to the unknown-workspace group once
   * their `workspaceId` no longer resolves.
   *
   * No local removal happens on the rows, deliberately: after the registration
   * is gone the same sessions are still archived, so dropping them locally
   * would show a state the next refresh contradicts. Only the next `list()`
   * decides where they belong.
   */
  async deleteWorkspaceRegistration(workspaceId: string): Promise<WorkspaceRegistrationOutcome> {
    const result = await this.remote.deleteWorkspaceRegistration({ workspaceId })
    if (!result.ok) throw new Error(result.error.message)
    if ('deleted' in result.value) return 'deleted'
    const error = new Error(result.value.message)
    Object.assign(error, result.value)
    if (result.value.code === 'workspace-not-found') return 'not-found'
    throw error
  }

  /** Drop every item that belongs to one workspace group. */
  removeByWorkspace(workspaceId: string | undefined): void {
    const belongs = (item: ArchivedSessionItem): boolean =>
      workspaceId === undefined ? item.workspaceId === undefined : item.workspaceId === workspaceId
    const dropped = this.state.items.filter(belongs)
    if (dropped.length === 0) return
    for (const item of dropped) this.forgetDetails(item.sessionId)
    this.state = {
      ...this.state,
      items: this.state.items.filter(item => !belongs(item)),
    }
    this.emit()
  }

  /** Idempotently drop one id from the local list. */
  removeById(sessionId: string): void {
    const items = this.state.items.filter(item => item.sessionId !== sessionId)
    if (items.length === this.state.items.length) return
    this.forgetDetails(sessionId)
    this.state = {
      ...this.state,
      items,
    }
    this.emit()
  }

  /**
   * Fold one `details` response into the current rows. Only rows still waiting
   * are patched: a row the listing already answered (a resident session) is
   * newer than a cached fold, and `lastActivityAt` keeps the caller's
   * `createdAt` floor because the host folds event times only.
   */
  private applyDetails(details: readonly ArchivedSessionDetail[]): void {
    if (details.length === 0) return
    const byId = new Map(details.map(detail => [detail.sessionId, detail]))
    for (const detail of details) {
      if (detail.detailsLoaded) this.details.set(detail.sessionId, detail)
      else this.unreadable.add(detail.sessionId)
    }
    const items = this.state.items.map(item => {
      if (item.detailsLoaded) return item
      const detail = byId.get(item.sessionId)
      if (detail === undefined || !detail.detailsLoaded) return item
      return {
        ...item,
        title: detail.title,
        lastActivityAt: Math.max(detail.lastActivityAt, item.createdAt),
        detailsLoaded: true,
      }
    })
    this.state = { ...this.state, items }
  }

  /** Re-apply hydrated values to a freshly listed row set. */
  private withCachedDetails(items: readonly ArchivedSessionItem[]): readonly ArchivedSessionItem[] {
    if (this.details.size === 0) return items
    return items.map(item => {
      if (item.detailsLoaded) return item
      const detail = this.details.get(item.sessionId)
      if (detail === undefined) return item
      return {
        ...item,
        title: detail.title,
        lastActivityAt: Math.max(detail.lastActivityAt, item.createdAt),
        detailsLoaded: true,
      }
    })
  }

  /** Drop cached hydration for one id (restored or deleted rows). */
  private forgetDetails(sessionId: string): void {
    this.details.delete(sessionId)
    this.unreadable.delete(sessionId)
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
        // A re-listing is header-only again; keep the titles this store has
        // already hydrated instead of flashing them back to placeholders.
        items: this.withCachedDetails(result.value.items),
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
