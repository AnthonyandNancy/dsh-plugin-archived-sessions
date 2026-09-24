/**
 * Wire types for the Archived Sessions plugin Host Remote API.
 * These are deliberately JSON-safe: no branded runtime values cross the seam.
 */

/** One archived session row shown in the Settings page. */
export interface ArchivedSessionItem {
  readonly sessionId: string
  /**
   * Latest `session/title` event text, or a fallback derived from the first
   * user message. Only meaningful while {@link ArchivedSessionItem.detailsLoaded}
   * is true; until then it is the id-derived placeholder a row shows before its
   * log has been read.
   */
  readonly title: string
  /** Stable workspace id when the session still has a workspace accounting slot. */
  readonly workspaceId?: string
  /** Workspace display title when known. */
  readonly workspaceTitle?: string
  /** Absolute workspace path when known. */
  readonly workspacePath?: string
  /** Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Later of creation and the latest human prompt / title event; used as the v1 "last activity" sort key. */
  readonly lastActivityAt: number
  /** Whether an agent is currently running for this session. */
  readonly running: boolean
  /**
   * Whether `title` / `lastActivityAt` were folded from the session's log, or
   * from its resident in-memory session. A header-only row costs no log read,
   * so the listing can answer immediately for an arbitrary archive size; the
   * rows a client actually shows are filled in through the `details` Remote.
   */
  readonly detailsLoaded: boolean
}

/**
 * One row's log-derived fields, answered by the `details` Remote.
 *
 * `lastActivityAt` is the latest human/title event time only: the host folding
 * a cold log has no reason to re-list every stored header just to floor one
 * value, so the caller applies its own `createdAt` floor (the same rule the
 * full row uses).
 */
export interface ArchivedSessionDetail {
  readonly sessionId: string
  readonly title: string
  /** Latest human prompt / title event time; `0` when the log carries none. */
  readonly lastActivityAt: number
  /** Whether the log was read; false keeps the caller's header-only values. */
  readonly detailsLoaded: boolean
}

export interface ArchivedSessionsDetailsRequest {
  readonly sessionIds: readonly string[]
}

export interface ArchivedSessionsDetailsResult {
  readonly items: readonly ArchivedSessionDetail[]
}

export interface ArchivedSessionListRequest {
  readonly signal?: AbortSignal
}

/**
 * Which runtime path backs each destructive capability, detected by the Host
 * and shipped with every list so the client can gate the UI without a second
 * round trip. `restore` also reaches the client through the restore Remote's
 * domain result; this is the advisory channel that keeps buttons disabled.
 *
 * `delete` reports `native` when the Host can actually remove a session's
 * durable log. DSH ships no session-deletion API in any released version —
 * the persistence seam is create/open/stat/list/flush — so on the shipped
 * JSONL backend this means the backend exposed a way to locate the artifact
 * (`listArtifacts` / `locate`) and the Host removes the log files itself.
 * `unsupported` only appears on a runtime that exposes neither, and keeps the
 * delete actions disabled rather than failing at click time.
 */
export interface ArchivedSessionsCapabilities {
  readonly restore: 'native' | 'rc6-compat' | 'unsupported'
  readonly delete: 'native' | 'unsupported'
  /** Whether `deleteWorkspaceRegistration` can remove a Workspace registration. */
  readonly workspaceDelete: 'native' | 'unsupported'
}

export interface ArchivedSessionListResult {
  readonly items: readonly ArchivedSessionItem[]
  readonly capabilities: ArchivedSessionsCapabilities
}

export interface ArchivedSessionDeleteRequest {
  readonly sessionId: string
}

export interface ArchivedSessionDeleteResult {
  readonly deleted: true
}

/** Business failure used by delete when the session is running. */
export interface ArchivedSessionRunningError {
  readonly code: 'session-running'
  readonly sessionId: string
  readonly message: string
}

/**
 * Business failure used by delete when the id is no longer in the archived
 * session set (already restored or already deleted).
 */
export interface ArchivedSessionNotFoundError {
  readonly code: 'session-not-found'
  readonly sessionId: string
  readonly message: string
}

/**
 * Domain result for a runtime without `SessionPersistence.delete`. The
 * capability is reported as `unsupported` in the list and the delete button
 * is disabled in the UI; if a client still issues the delete Remote, the
 * Host answers with this domain result instead of failing plugin startup.
 */
export interface ArchivedSessionDeleteUnsupportedError {
  readonly code: 'delete-unsupported'
  readonly sessionId: string
  readonly message: string
}

/**
 * One workspace group's bulk delete request.
 *
 * workspaceId omitted means the ungrouped / unknown-workspace
 * archived-session group.
 */
export interface ArchivedWorkspaceDeleteRequest {
  readonly workspaceId?: string
}

export interface ArchivedWorkspaceDeleteResult {
  readonly deleted: true
  readonly deletedCount: number
}

/** Business failure used by workspace delete when any session in the group is running. */
export interface ArchivedWorkspaceRunningError {
  readonly code: 'workspace-sessions-running'
  readonly workspaceId?: string | undefined
  readonly runningSessionCount: number
  /** Id of the first running session found by the preflight (when known). */
  readonly sessionId?: string
  /** Display title of the first running session found by the preflight (when known). */
  readonly title?: string
  readonly message: string
}

export interface ArchivedWorkspaceDeleteUnsupportedError {
  readonly code: 'workspace-delete-unsupported'
  readonly workspaceId?: string | undefined
  readonly message: string
}

/** Non-running delete failure after some sessions were already irreversibly deleted. */
export interface ArchivedWorkspaceDeletePartialError {
  readonly code: 'workspace-delete-partial'
  readonly workspaceId?: string | undefined
  readonly deletedCount: number
  readonly failedSessionId: string
  readonly message: string
}

export type ArchivedWorkspaceDeleteValue =
  | ArchivedWorkspaceDeleteResult
  | ArchivedWorkspaceRunningError
  | ArchivedWorkspaceDeleteUnsupportedError
  | ArchivedWorkspaceDeletePartialError

/**
 * Request to remove a DSH Workspace registration from the workspace list.
 *
 * This is deliberately separate from {@link ArchivedWorkspaceDeleteRequest}:
 * that one permanently deletes the archived *sessions* of one group and keeps
 * the registration, while this one removes the *registration* and keeps every
 * directory, file and session log — the official
 * `WorkspaceRegistry.delete()` semantics, which the sessions of that workspace
 * survive as Ungrouped.
 *
 * `workspaceId` is optional only so the wire type can express the ungrouped
 * group, which has no registration: the Host refuses that case with
 * `workspace-not-found` rather than inventing one.
 */
export interface ArchivedWorkspaceRegistrationDeleteRequest {
  readonly workspaceId?: string | undefined
}

export interface ArchivedWorkspaceRegistrationDeleteResult {
  readonly deleted: true
  readonly workspaceId: string
}

/**
 * Domain result for an id the registry no longer knows. The registry treats
 * this as an idempotent no-op, so it is reported as a value rather than an
 * error: the requested end state (no such registration) already holds.
 */
export interface ArchivedWorkspaceRegistrationNotFoundError {
  readonly code: 'workspace-not-found'
  readonly workspaceId?: string | undefined
  readonly message: string
}

/**
 * Domain result for a runtime whose registry exposes no `delete`. The
 * capability is reported as `unsupported` in the list and the action is
 * disabled in the UI; a client that still calls the Remote gets this value
 * instead of a transport failure.
 */
export interface ArchivedWorkspaceRegistrationDeleteUnsupportedError {
  readonly code: 'workspace-registration-delete-unsupported'
  readonly workspaceId?: string | undefined
  readonly message: string
}

export type ArchivedWorkspaceRegistrationDeleteValue =
  | ArchivedWorkspaceRegistrationDeleteResult
  | ArchivedWorkspaceRegistrationNotFoundError
  | ArchivedWorkspaceRegistrationDeleteUnsupportedError

export type ArchivedSessionDeleteValue =
  | ArchivedSessionDeleteResult
  | ArchivedSessionRunningError
  | ArchivedSessionNotFoundError
  | ArchivedSessionDeleteUnsupportedError

export interface ArchivedSessionRestoreRequest {
  readonly sessionId: string
}

export interface ArchivedSessionRestoreResult {
  readonly restored: true
}

/**
 * Domain result for a runtime with no restore path (neither the official
 * `unarchiveSession` nor the rc.6 mutation surface). Reported as a value —
 * never thrown — so capability gaps do not look like transport failures.
 */
export interface ArchivedSessionUnsupportedError {
  readonly code: 'restore-unsupported'
  readonly sessionId: string
  readonly message: string
}

export type ArchivedSessionRestoreValue =
  | ArchivedSessionRestoreResult
  | ArchivedSessionUnsupportedError
