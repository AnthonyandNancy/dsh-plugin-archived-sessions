/**
 * Host-side archive compatibility adapter.
 *
 * One capability-detecting entry point for both restore and archive-set
 * cleanup, so the plugin never hard-depends on which DSH runtime it runs on:
 *
 *   - `native`      — the registry already exposes `unarchiveSession`
 *                     (future DSH builds with the official API).
 *   - `rc6-compat`  — no `unarchiveSession`, but the registry exposes the
 *                     rc.6 mutation surface (`enqueueOperation` /
 *                     `requireState` / `setState`) with an
 *                     `archivedSessionIds` set in its durable state.
 *   - `unsupported` — neither path; the caller surfaces a domain result and
 *                     the plugin keeps running.
 *
 * Detection is pure runtime capability probing (`typeof` checks), never a
 * version-string comparison, so a future DSH that adds the official API is
 * picked up automatically and the rc.6 shim simply stops running.
 *
 * The rc.6 path mutates the registry through its own
 * `enqueueOperation → requireState → setState` chain — the same mutation path
 * the registry uses internally — so in-memory state and the durable domain
 * state stay consistent, and the operation is serialized against every other
 * registry write. It only rewrites `archivedSessionIds`; workspace
 * `sessionIds` accounting is untouched, which is what restores the session to
 * its original workspace slot and position.
 *
 * No DSH source, prototype, or storage file is modified from here: the
 * adapter calls the runtime's own methods on the instance it is handed.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** How restore / archive-set cleanup can be performed on the current runtime. */
export type RestoreCapability = 'native' | 'rc6-compat' | 'unsupported'

/**
 * Business-layer entry point. Services depend on this interface, not on the
 * runtime's registry shape.
 */
export interface RestoreAdapter {
  restore(sessionId: SessionId): Promise<void>
  getRestoreCapability(): RestoreCapability
}

/**
 * Minimal rc.6 `WorkspaceRegistry` state read by the compat path. Kept local
 * to this module so the plugin never re-declares the full DSH registry type.
 * The registry's durable state carries `archivedSessionIds` next to its other
 * fields; only the archive set participates in a restore.
 */
interface Rc6WorkspaceState {
  readonly archivedSessionIds: readonly SessionId[]
  readonly [key: string]: unknown
}

/**
 * Minimal rc.6 `WorkspaceRegistry` mutation surface. These methods are the
 * registry's own serialized mutation path (TS `private` at compile time, but
 * plain runtime properties — which is why `typeof` probing works).
 */
export interface Rc6WorkspaceRegistryCompat {
  readonly archivedSessionIds: readonly SessionId[]
  enqueueOperation<T>(operation: () => Promise<T>): Promise<T>
  requireState(): Rc6WorkspaceState
  setState(state: unknown): Promise<void>
}

/** Thrown only when `restore()` is called on a runtime with no restore path. */
export class RestoreUnsupportedError extends Error {
  readonly sessionId: SessionId

  constructor(sessionId: SessionId) {
    super(`archived-sessions: restore is unavailable on this DSH runtime (session "${sessionId}")`)
    this.name = 'RestoreUnsupportedError'
    this.sessionId = sessionId
  }
}

function isRc6Registry(registry: unknown): registry is Rc6WorkspaceRegistryCompat {
  if (registry === null || typeof registry !== 'object') return false
  const candidate = registry as Partial<Rc6WorkspaceRegistryCompat>
  return (
    typeof candidate.enqueueOperation === 'function'
    && typeof candidate.requireState === 'function'
    && typeof candidate.setState === 'function'
  )
}

/**
 * rc.6 restore primitive: drop the id from the durable archive set through
 * the registry's own serialized mutation chain. A session that is not
 * archived resolves as a no-op, so restores are idempotent.
 */
async function restoreRc6(registry: Rc6WorkspaceRegistryCompat, sessionId: SessionId): Promise<void> {
  await registry.enqueueOperation(async () => {
    const state = registry.requireState()
    if (!state.archivedSessionIds.includes(sessionId)) return
    await registry.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
    })
  })
}

/**
 * Capability-detecting archive adapter over one runtime registry instance.
 *
 * Construction never throws and never inspects version strings: on any
 * unknown runtime shape both flags are false and every operation degrades to
 * `unsupported`, so the plugin starts and lists normally everywhere.
 */
export class ArchiveCompatibilityAdapter implements RestoreAdapter {
  private readonly registry: unknown
  private readonly native: boolean
  private readonly rc6: boolean

  constructor(registry: unknown) {
    this.registry = registry
    const maybeNative = registry as { unarchiveSession?: unknown } | null | undefined
    this.native = typeof maybeNative?.unarchiveSession === 'function'
    // Native API wins; the rc.6 shim must never run alongside it.
    this.rc6 = !this.native && isRc6Registry(registry)
  }

  getRestoreCapability(): RestoreCapability {
    if (this.native) return 'native'
    if (this.rc6) return 'rc6-compat'
    return 'unsupported'
  }

  /**
   * Restore one session through whichever path the runtime supports. Throws
   * {@link RestoreUnsupportedError} only when the capability is
   * `unsupported`; services are expected to gate on the capability first and
   * surface that state as a domain result.
   */
  async restore(sessionId: SessionId): Promise<void> {
    if (this.getRestoreCapability() === 'unsupported') {
      throw new RestoreUnsupportedError(sessionId)
    }
    await this.removeFromArchiveSet(sessionId)
  }

  /**
   * Shared underlying primitive: remove a session from the archive set.
   * Restore routes through here, and delete cleanup reuses it after the
   * durable session log is gone — one rc.6 mutation path, two callers.
   */
  async removeFromArchiveSet(sessionId: SessionId): Promise<void> {
    if (this.native) {
      const registry = this.registry as { unarchiveSession(sessionId: SessionId): Promise<void> }
      return registry.unarchiveSession(sessionId)
    }
    if (this.rc6) {
      return restoreRc6(this.registry as Rc6WorkspaceRegistryCompat, sessionId)
    }
    // No mutation path on this runtime: nothing to remove. The caller
    // decides whether that is an error (restore) or a skipped cleanup
    // (delete, which is best-effort after the durable delete commits).
  }
}
