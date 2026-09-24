/**
 * Test-only fixture for durable session logs on a real temporary root.
 *
 * Production code never derives artifact paths by hand — it asks the backend
 * (`listArtifacts`, falling back to `locate`). Tests need real files to delete,
 * so this module reproduces DSH's JSONL layout for the ids it creates. The
 * `cwd` is a constant, which keeps the layout a pure function of the session
 * id, so a test can build a body and find its path again.
 *
 * Layout reproduced from `@deepseek-ai/dsh-session-persistence-jsonl`:
 * `<root>/<projectKey(cwd)>/<encodeSegment(id)>/session.vN.jsonl.zstd`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The cwd every fixture session pretends to live in. */
export const FIXTURE_CWD = 'D:\\code\\fixture-project'

/** Current log generation in DSH 0.1.7-rc.1 (`SESSION_FORMAT_VERSION = 4`). */
export const CURRENT_LOG_FILENAME = 'session.v4.jsonl.zstd'

const ROOT = mkdtempSync(join(tmpdir(), 'archived-sessions-service-'))

/** Remove the shared fixture root; registered as an after() hook by the suite. */
export function cleanupSessionLogs(): void {
  rmSync(ROOT, { recursive: true, force: true })
}

/** Single safe path segment, mirroring the backend's `encodeSegment`. */
function encodeSegment(raw: string): string {
  let out = ''
  for (const ch of raw) {
    out += /^[A-Za-z0-9._-]$/.test(ch) && ch !== '~'
      ? ch
      : `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Readable project directory key, mirroring the backend's `projectKey`. */
function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (/^[A-Za-z0-9._-]$/.test(ch) && ch !== '~') {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** The session-owned directory this fixture uses for one id. */
export function fixtureSessionDir(sessionId: string): string {
  return join(ROOT, projectKey(FIXTURE_CWD), encodeSegment(sessionId))
}

/** The current-generation log path this fixture uses for one id. */
export function fixtureLogPath(sessionId: string): string {
  return join(fixtureSessionDir(sessionId), CURRENT_LOG_FILENAME)
}

/** The session storage root the fake persistence service reports. */
export function fixtureRoot(): string {
  return ROOT
}

/**
 * Materialize one session's log (and optionally an older generation) so a test
 * can assert it is really gone afterwards.
 */
export function writeSessionLog(sessionId: string, options: { olderGeneration?: boolean } = {}): string {
  const dir = fixtureSessionDir(sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, CURRENT_LOG_FILENAME)
  writeFileSync(path, JSON.stringify({ type: 'session', id: sessionId }))
  if (options.olderGeneration === true) {
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), JSON.stringify({ type: 'session', id: sessionId }))
  }
  return path
}

/** The stored `SessionHeader` shape the service reads for listing and locate. */
export interface FixtureHeader {
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd: string
}

/** Build one stored header for the fixture layout. */
export function fixtureHeader(sessionId: string): FixtureHeader {
  return { id: sessionId as SessionId, createdAt: 1_700_000_000_000, cwd: FIXTURE_CWD }
}
