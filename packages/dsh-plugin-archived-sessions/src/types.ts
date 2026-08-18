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

export interface ArchivedSessionListResult {
  readonly items: readonly ArchivedSessionItem[]
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

export type ArchivedSessionDeleteValue =
  | ArchivedSessionDeleteResult
  | ArchivedSessionRunningError
