/**
 * SessionLogDeleter tests against a real temporary session root.
 *
 * The whole risk of permanent delete lives on the filesystem boundary, so
 * these tests use real files rather than a fake fs: what must hold is that
 * every canonical generation disappears, that unrelated files survive, that a
 * path resolving outside the configured root is refused, and that the shared
 * project directory is never removed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLogDeleter } from '../src/host/session-log.ts'
import type { SessionLogStorage } from '../src/host/session-log.ts'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'

const PROJECT_KEY = '--D-code-demo--'

function makeHeader(id: string, cwd: string): SessionHeader {
  return { id, version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd } as unknown as SessionHeader
}

interface Harness {
  root: string
  sessionDir: string
  header: SessionHeader
  storage: SessionLogStorage
  artifactPath: string
}

/**
 * One project directory with one session directory holding the artifact set a
 * real DSH install accumulates: two canonical generations, a lock residue, a
 * temp leftover, and one file that is none of those.
 */
function makeHarness(overrides: Partial<SessionLogStorage> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'archived-sessions-log-'))
  const id = 'session-11111111-2222-3333-4444-555555555555'
  const cwd = 'D:\\code\\demo'
  const sessionDir = join(root, PROJECT_KEY, id)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), 'current')
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), 'historical')
  writeFileSync(join(sessionDir, 'session.jsonl.zstd'), 'v0')
  writeFileSync(join(sessionDir, 'session.lock'), '')
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd.abcdef123456.tmp'), 'partial')
  writeFileSync(join(sessionDir, 'notes.txt'), 'unrelated')
  const header = makeHeader(id, cwd)
  const artifactPath = join(sessionDir, 'session.v4.jsonl.zstd')
  const storage: SessionLogStorage = {
    root,
    listArtifacts: async () => [{ header, path: artifactPath }],
    ...overrides,
  }
  return { root, sessionDir, header, storage, artifactPath }
}

function cleanup(harness: Harness): void {
  rmSync(harness.root, { recursive: true, force: true })
}

test('deleter: reports artifacts capability when the runtime lists artifacts', () => {
  const harness = makeHarness()
  try {
    assert.equal(new SessionLogDeleter(harness.storage).getDeleteCapability(), 'artifacts')
  } finally {
    cleanup(harness)
  }
})

test('deleter: falls back to locate when the runtime cannot list artifacts', () => {
  const harness = makeHarness()
  try {
    const deleter = new SessionLogDeleter({
      root: harness.root,
      locate: () => ({ kind: 'jsonl', path: harness.artifactPath }),
    })
    assert.equal(deleter.getDeleteCapability(), 'locate')
  } finally {
    cleanup(harness)
  }
})

test('deleter: reports unsupported when the runtime exposes neither surface', () => {
  const deleter = new SessionLogDeleter({ root: 'C:\\nowhere' })
  assert.equal(deleter.getDeleteCapability(), 'unsupported')
})

test('deleter: unsupported runtime refuses to remove instead of reporting success', async () => {
  const deleter = new SessionLogDeleter({ root: 'C:\\nowhere' })
  await assert.rejects(
    () => deleter.remove('session-x' as SessionId, undefined),
    /exposes no way to locate a stored session log/,
  )
})

test('deleter: removes every canonical generation, the lock residue and temp leftovers', async () => {
  const harness = makeHarness()
  try {
    await new SessionLogDeleter(harness.storage).remove(
      harness.header.id as SessionId,
      harness.header,
    )
    // Every generation must go: resolveGenerationInDirectory selects the
    // highest version present, so a surviving older one resurrects the session
    // through the migration path.
    assert.equal(existsSync(join(harness.sessionDir, 'session.v4.jsonl.zstd')), false)
    assert.equal(existsSync(join(harness.sessionDir, 'session.v3.jsonl.zstd')), false)
    assert.equal(existsSync(join(harness.sessionDir, 'session.jsonl.zstd')), false)
    assert.equal(existsSync(join(harness.sessionDir, 'session.lock')), false)
    assert.equal(existsSync(join(harness.sessionDir, 'session.v4.jsonl.zstd.abcdef123456.tmp')), false)
  } finally {
    cleanup(harness)
  }
})

test('deleter: an unrelated file survives and keeps the session directory alive', async () => {
  const harness = makeHarness()
  try {
    await new SessionLogDeleter(harness.storage).remove(
      harness.header.id as SessionId,
      harness.header,
    )
    assert.equal(existsSync(join(harness.sessionDir, 'notes.txt')), true)
    assert.equal(existsSync(harness.sessionDir), true)
  } finally {
    cleanup(harness)
  }
})

test('deleter: an emptied session directory is reclaimed', async () => {
  const harness = makeHarness()
  try {
    rmSync(join(harness.sessionDir, 'notes.txt'), { force: true })
    await new SessionLogDeleter(harness.storage).remove(
      harness.header.id as SessionId,
      harness.header,
    )
    assert.equal(existsSync(harness.sessionDir), false)
  } finally {
    cleanup(harness)
  }
})

test('deleter: the shared project directory survives even when its last session goes', async () => {
  const harness = makeHarness()
  try {
    rmSync(join(harness.sessionDir, 'notes.txt'), { force: true })
    await new SessionLogDeleter(harness.storage).remove(
      harness.header.id as SessionId,
      harness.header,
    )
    assert.equal(existsSync(join(harness.root, PROJECT_KEY)), true)
    assert.equal(existsSync(harness.root), true)
  } finally {
    cleanup(harness)
  }
})

test('deleter: the project directory survives while another session lives in it', async () => {
  const harness = makeHarness()
  try {
    const sibling = join(harness.root, PROJECT_KEY, 'session-99999999-0000-1111-2222-333333333333')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'session.v4.jsonl.zstd'), 'sibling')
    await new SessionLogDeleter(harness.storage).remove(
      harness.header.id as SessionId,
      harness.header,
    )
    assert.equal(existsSync(join(sibling, 'session.v4.jsonl.zstd')), true)
    // The other session's log keeps the shared project directory alive.
    assert.equal(existsSync(join(harness.root, PROJECT_KEY)), true)
  } finally {
    cleanup(harness)
  }
})

test('deleter: refuses an artifact path outside the storage root', async () => {
  const harness = makeHarness()
  const outside = mkdtempSync(join(tmpdir(), 'archived-sessions-outside-'))
  try {
    writeFileSync(join(outside, 'session.v4.jsonl.zstd'), 'not ours')
    const deleter = new SessionLogDeleter({
      root: harness.root,
      listArtifacts: async () => [{
        header: harness.header,
        path: join(outside, 'session.v4.jsonl.zstd'),
      }],
    })
    await assert.rejects(
      () => deleter.remove(harness.header.id as SessionId, harness.header),
      /outside the session storage root/,
    )
    assert.equal(existsSync(join(outside, 'session.v4.jsonl.zstd')), true)
  } finally {
    cleanup(harness)
    rmSync(outside, { recursive: true, force: true })
  }
})

test('deleter: refuses a traversal path that escapes the root', async () => {
  const harness = makeHarness()
  try {
    const deleter = new SessionLogDeleter({
      root: harness.root,
      listArtifacts: async () => [{
        header: harness.header,
        // A hostile header cwd would try to climb out of the root.
        path: join(harness.root, '..', 'escape', 'session.v4.jsonl.zstd'),
      }],
    })
    await assert.rejects(
      () => deleter.remove(harness.header.id as SessionId, harness.header),
      /outside the session storage root/,
    )
  } finally {
    cleanup(harness)
  }
})

test('deleter: a session with no locatable artifact is a no-op', async () => {
  const harness = makeHarness({ listArtifacts: async () => [] })
  try {
    await new SessionLogDeleter(harness.storage).remove(
      'session-absent' as SessionId,
      undefined,
    )
    assert.equal(existsSync(join(harness.sessionDir, 'session.v4.jsonl.zstd')), true)
  } finally {
    cleanup(harness)
  }
})

test('deleter: the locate fallback only runs when a header is available', async () => {
  const harness = makeHarness()
  try {
    const deleter = new SessionLogDeleter({
      root: harness.root,
      locate: () => ({ path: harness.artifactPath }),
    })
    // No header means no path can be derived; the deleter must not guess.
    await deleter.remove(harness.header.id as SessionId, undefined)
    assert.equal(existsSync(join(harness.sessionDir, 'session.v4.jsonl.zstd')), true)

    await deleter.remove(harness.header.id as SessionId, harness.header)
    assert.equal(existsSync(join(harness.sessionDir, 'session.v4.jsonl.zstd')), false)
  } finally {
    cleanup(harness)
  }
})

test('deleter: a session whose directory vanished is a tolerated no-op', async () => {
  const harness = makeHarness()
  try {
    rmSync(harness.sessionDir, { recursive: true, force: true })
    await new SessionLogDeleter(harness.storage).remove(
      harness.header.id as SessionId,
      harness.header,
    )
  } finally {
    cleanup(harness)
  }
})
