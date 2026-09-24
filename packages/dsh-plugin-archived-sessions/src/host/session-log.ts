/**
 * Host-side durable session-log removal for the JSONL persistence backend.
 *
 * DSH 0.1.7-rc.1 ships no session-deletion API — the persistence seam is
 * create/open/stat/list/flush, and the backend's own README states the logs
 * accumulate under the root "until removed externally". An archived-session
 * manager that can delete a session therefore has to remove the log artifacts
 * itself, which makes this module the only place in the plugin that touches
 * session files, and the only place allowed to call a filesystem delete.
 *
 * Safety rules, in order:
 *
 *   1. Path resolution never re-derives the layout. The authoritative path
 *      comes from `SessionPersistence.listArtifacts()` (the same listing DSH
 *      itself uses; it validates the stored id and refuses duplicate ids).
 *      `locate(header)` is the documented narrow fallback.
 *   2. Every resolved path must live strictly under the backend's own root,
 *      compared after `resolve()`, before anything is removed.
 *   3. Only session-owned artifacts are removed: canonical log generations
 *      (`session.jsonl[.zstd]`, `session.vN.jsonl[.zstd]` — every generation,
 *      because a surviving older one would resurrect the session through the
 *      migration path), the POSIX `session.lock` residue, and `*.tmp`
 *      leftovers. Unknown files survive.
 *   4. The session directory is removed only when it is empty afterwards, and
 *      the shared project directory is never removed.
 *
 * The backend reopens a session's log by path on every append, so deleting a
 * log that still has a live writer recreates a headerless file on the next
 * batch instead of producing a clean absence. Callers must therefore refuse to
 * delete a session that is live or running; this module cannot detect that.
 *
 * @module dsh-plugin-archived-sessions/host/session-log
 */

import { readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'

/** How durable log artifacts can be located and removed on this runtime. */
export type SessionLogDeleteCapability = 'artifacts' | 'locate' | 'unsupported'

/**
 * Minimal durable-storage surface used for removal. Every member beyond
 * `root` is optional so the adapter probes the runtime rather than comparing
 * version strings.
 */
export interface SessionLogStorage {
  /** The backend's session root; the fence for every path this module touches. */
  readonly root: string
  /** 0.1.7+ JSONL backend: every visible stored session with its real path. */
  listArtifacts?(signal?: AbortSignal): Promise<
    readonly { readonly header: SessionHeader; readonly path: string }[]
  >
  /** Narrow fallback: the absolute artifact path derived from a header. */
  locate?(header: SessionHeader): { readonly kind?: string; readonly path: string } | undefined
}

/**
 * Canonical session-log file names this module is allowed to remove: the v0
 * `session.jsonl` plus every `.vN` generation, each in compressed and plain
 * form. Any file not matching (or not being `session.lock` / `*.tmp`) is left
 * in place — the session directory is reserved for future session-local
 * artifacts.
 */
const LOG_FILE_PATTERN = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u
const LOCK_FILE_NAME = 'session.lock'
const TEMP_FILE_PATTERN = /\.tmp$/u

/** Filesystem errors worth retrying: a competing DSH writer may hold the file briefly. */
const TRANSIENT_DELETE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const DELETE_ATTEMPTS = 3
const DELETE_RETRY_DELAY_MS = 25

/** Thrown when a resolved artifact path escapes the storage root. */
export class SessionLogPathRefusedError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`archived-sessions: refusing to delete "${path}": it is outside the session storage root`)
    this.name = 'SessionLogPathRefusedError'
    this.path = path
  }
}

/** Whether one session directory entry is a session-owned artifact. */
function isRemovableArtifact(name: string): boolean {
  return LOG_FILE_PATTERN.test(name)
    || name === LOCK_FILE_NAME
    || TEMP_FILE_PATTERN.test(name)
}

/** Error code of a filesystem rejection, when it carries one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => { setTimeout(resolveDelay, ms) })
}

/**
 * Remove one path, retrying the transient sharing violations a concurrent DSH
 * writer can produce on Windows. `force: true` makes an already-absent path a
 * success, so callers never have to distinguish "gone" from "removed".
 */
async function removeFile(path: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { force: true })
      return
    } catch (error: unknown) {
      const code = errorCode(error)
      if (attempt >= DELETE_ATTEMPTS || code === undefined || !TRANSIENT_DELETE_CODES.has(code)) throw error
      await delay(DELETE_RETRY_DELAY_MS * attempt)
    }
  }
}

/**
 * Capability-detecting remover over one runtime persistence instance.
 *
 * Construction never throws and never reads a version string: a runtime whose
 * storage exposes neither listing surface reports `unsupported`, the delete
 * capability stays disabled in the UI, and the plugin still starts.
 */
export class SessionLogDeleter {
  private readonly storage: SessionLogStorage
  private readonly root: string
  private readonly capability: SessionLogDeleteCapability

  constructor(storage: SessionLogStorage) {
    this.storage = storage
    // Resolved once with a trailing separator: prefix comparison then cannot
    // match a sibling directory that merely shares the root's name prefix.
    this.root = `${resolve(storage.root)}${sep}`
    this.capability = typeof storage.listArtifacts === 'function'
      ? 'artifacts'
      : typeof storage.locate === 'function'
        ? 'locate'
        : 'unsupported'
  }

  getDeleteCapability(): SessionLogDeleteCapability {
    return this.capability
  }

  /**
   * Every visible stored session's authoritative artifact path, keyed by id.
   * An empty map is the honest answer for a runtime whose listing is
   * unavailable; it is also what an already-deleted session looks like.
   */
  private async artifactPaths(): Promise<ReadonlyMap<string, string>> {
    const paths = new Map<string, string>()
    const listArtifacts = this.storage.listArtifacts
    if (typeof listArtifacts !== 'function') return paths
    for (const artifact of await listArtifacts.call(this.storage)) {
      paths.set(artifact.header.id, artifact.path)
    }
    return paths
  }

  /** The authoritative log path for one session, or undefined when it has none. */
  private async resolveArtifactPath(
    sessionId: SessionId,
    header: SessionHeader | undefined,
  ): Promise<string | undefined> {
    if (this.capability === 'artifacts') {
      return (await this.artifactPaths()).get(sessionId)
    }
    if (this.capability === 'locate' && header !== undefined) {
      return this.storage.locate?.(header)?.path
    }
    return undefined
  }

  /** Refuse any path that is not strictly inside the storage root. */
  private assertInsideRoot(path: string): string {
    const absolute = resolve(path)
    if (!absolute.startsWith(this.root)) throw new SessionLogPathRefusedError(path)
    return absolute
  }

  /**
   * The removable artifacts currently present in a session directory.
   *
   * A directory that no longer exists yields nothing: another deletion or an
   * operator already removed it, which is the end state the caller asked for.
   */
  private async scanArtifacts(sessionDir: string): Promise<string[]> {
    let entries
    try {
      entries = await readdir(sessionDir, { withFileTypes: true })
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const paths: string[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !isRemovableArtifact(entry.name)) continue
      paths.push(this.assertInsideRoot(resolve(sessionDir, entry.name)))
    }
    return paths
  }

  /**
   * Remove one session's durable log artifacts.
   *
   * A session with no locatable artifact is a no-op: nothing durable is left,
   * which is the outcome the caller asked for. A refused or failed removal
   * throws — a destructive operation must never report success it did not
   * achieve.
   */
  async remove(sessionId: SessionId, header: SessionHeader | undefined): Promise<void> {
    if (this.capability === 'unsupported') {
      throw new Error('archived-sessions: this DSH runtime exposes no way to locate a stored session log')
    }
    const resolvedPath = await this.resolveArtifactPath(sessionId, header)
    if (resolvedPath === undefined) return

    const artifactPath = this.assertInsideRoot(resolvedPath)
    const sessionDir = dirname(artifactPath)
    // The session directory and its shared project parent are both checked:
    // the artifact check alone would still permit removing a project dir.
    this.assertInsideRoot(sessionDir)

    for (const path of await this.scanArtifacts(sessionDir)) {
      await removeFile(path)
    }

    // Only an empty session directory is reclaimed; a directory still holding
    // unknown files is left alone, and the shared project directory is never
    // removed even when the last session in it disappears.
    await rmdir(sessionDir).catch((error: unknown) => {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') return
      throw error
    })
  }
}
