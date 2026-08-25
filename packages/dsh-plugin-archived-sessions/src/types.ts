/**
 * Wire types for the Archived Sessions plugin Host Remote API.
 * These are deliberately JSON-safe: no branded runtime values cross the seam.
 */

/** One archived session row shown in the Settings page. */
export interface ArchivedSessionItem {
  readonly sessionId: string
  /** Latest `session/title` event text, or a fallback derived from the first user message. */
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
}

export interface ArchivedSessionListRequest {
  readonly signal?: AbortSignal
}

/**
 * Which runtime path backs each destructive capability, detected by the Host
 * and shipped with every list so the client can gate the UI without a second
 * round trip. `restore` also reaches the client through the restore Remote's
 * domain result; this is the advisory channel that keeps buttons disabled.
 */
export interface ArchivedSessionsCapabilities {
  readonly restore: 'native' | 'rc6-compat' | 'unsupported'
  readonly delete: 'native' | 'unsupported'
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
