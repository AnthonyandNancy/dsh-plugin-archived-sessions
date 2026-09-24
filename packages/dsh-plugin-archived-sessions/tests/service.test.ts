/**
 * ArchivedSessionsService integration tests against fake runtime shapes:
 * rc.6 (no unarchiveSession, mutation surface present), future native
 * (unarchiveSession present), and unknown (neither). Verifies the service
 * starts and degrades to domain results instead of throwing.
 *
 * The service is imported from the compiled host output (`lib/types`): the
 * source uses TC39 `@Remote` decorators, which Node's type stripping cannot
 * transform, and this way the spec exercises the exact artifact that ships.
 * Run `tsc -b tsconfig.build.host.json` (part of `npm test`) first.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArchivedSessionsService } from '../lib/types/index.js'
import {
  cleanupSessionLogs,
  FIXTURE_CWD,
  fixtureHeader,
  fixtureLogPath,
  fixtureRoot,
  writeSessionLog,
} from './session-log-fixture.ts'

after(() => { cleanupSessionLogs() })

interface FakeState {
  readonly workspaceIds: string[]
  archivedSessionIds: string[]
}

interface FakeLiveSession {
  header: { id: SessionId; createdAt: number; cwd?: string }
  events?: readonly unknown[]
  snapshotEvents?(): readonly unknown[]
}

/** Storage surfaces of one DSH build; the service probes whichever exist. */
interface FakeSessionPersistence {
  root?: string
  listSnapshots?(): Promise<readonly { header: { id: SessionId; createdAt: number } }[]>
  list?(): Promise<readonly { header: { id: SessionId; createdAt: number } }[]>
  readFrom?(): Promise<{ events: readonly unknown[] }>
  open?(sessionId: SessionId, access: 'read'): Promise<{
    read(offset?: number): Promise<{ events: readonly unknown[] }>
    close(): Promise<void>
  }>
  listArtifacts?(signal?: AbortSignal): Promise<
    readonly { readonly header: { id: SessionId; createdAt: number; cwd?: string }; readonly path: string }[]
  >
  locate?(header: { id: SessionId; cwd?: string }): { readonly path: string } | undefined
}

interface FakeContext {
  workspaceRegistry: Record<string, unknown> & {
    readonly archivedSessionIds: readonly SessionId[]
    list(): unknown[]
  }
  sessionPersistence: FakeSessionPersistence
  sessions: { get(sessionId?: SessionId): FakeLiveSession | undefined }
  agents: { get(sessionId?: SessionId): { status?: 'idle' | 'running' } | undefined }
  get(key?: string): unknown
  logger: { warn(...args: unknown[]): void }
  reflect: { provide(): void }
}

/** rc.6-shaped context: no unarchiveSession, but the registry mutation surface exists. */
function makeRc6Context(initial: { sessionIds?: string[]; archivedSessionIds?: string[] } = {}) {
  const state: FakeState = {
    workspaceIds: [],
    archivedSessionIds: [...(initial.archivedSessionIds ?? [])],
  }
  const ctx: FakeContext = {
    workspaceRegistry: {
      get archivedSessionIds() {
        return state.archivedSessionIds
      },
      list: () => [],
      async enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
        return await operation()
      },
      requireState: () => state,
      async setState(next: unknown): Promise<void> {
        Object.assign(state, next as Partial<FakeState>)
      },
    },
    sessionPersistence: {
      root: fixtureRoot(),
      listSnapshots: async () =>
        (initial.archivedSessionIds ?? []).map(id => ({
          header: { id: id as SessionId, createdAt: 1_700_000_000_000, cwd: FIXTURE_CWD },
        })),
      readFrom: async () => ({ events: [] }),
      listArtifacts: async () =>
        (initial.archivedSessionIds ?? []).map(id => ({
          header: fixtureHeader(id),
          path: fixtureLogPath(id),
        })),
    },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    get: () => undefined,
    logger: { warn: () => {} },
    reflect: { provide: () => {} },
  }
  return { ctx, state }
}

function startService(ctx: FakeContext): ArchivedSessionsService {
  return new ArchivedSessionsService(ctx as unknown as Context)
}

test('rc.6 runtime: service starts, lists, and reports rc6-compat restore capability', async () => {
  const { ctx } = makeRc6Context({ archivedSessionIds: ['B'] })
  const service = startService(ctx)
  const result = await service.list()
  assert.equal(result.capabilities.restore, 'rc6-compat')
  assert.equal(result.capabilities.delete, 'native')
  assert.deepEqual(result.items.map(row => ({ sessionId: row.sessionId, title: row.title })), [
    { sessionId: 'B', title: '会话 B' },
  ])
})

test('rc.6 restore: removes the id from the archive set and returns restored:true', async () => {
  const { ctx, state } = makeRc6Context({ archivedSessionIds: ['B'] })
  const service = startService(ctx)
  const result = await service.restore({ sessionId: 'B' })
  assert.deepEqual(result, { restored: true })
  assert.deepEqual(state.archivedSessionIds, [])
})

test('rc.6 restore is idempotent through the service', async () => {
  const { ctx } = makeRc6Context({ archivedSessionIds: ['B'] })
  const service = startService(ctx)
  await service.restore({ sessionId: 'B' })
  const second = await service.restore({ sessionId: 'B' })
  assert.deepEqual(second, { restored: true })
})

test('unknown runtime: service still starts and restore answers restore-unsupported as a domain result', async () => {
  const { ctx } = makeRc6Context()
  delete ctx.workspaceRegistry.setState
  delete ctx.workspaceRegistry.enqueueOperation
  const service = startService(ctx)
  const result = await service.restore({ sessionId: 'B' })
  assert.equal(result.code, 'restore-unsupported')
  assert.equal(result.sessionId, 'B')
})

test('runtime without an artifact surface: service starts, reports delete unsupported, and answers delete-unsupported', async () => {
  const { ctx } = makeRc6Context()
  delete ctx.sessionPersistence.listArtifacts
  const service = startService(ctx)
  const list = await service.list()
  assert.equal(list.capabilities.delete, 'unsupported')
  const result = await service.delete({ sessionId: 'B' })
  assert.deepEqual(result, {
    code: 'delete-unsupported',
    sessionId: 'B',
    message: 'permanent delete is unavailable on this DSH runtime',
  })
})

test('rc.6 delete: cleanup routes through the adapter primitive and clears the archive set', async () => {
  writeSessionLog('B')
  const { ctx, state } = makeRc6Context({ archivedSessionIds: ['B'] })
  const service = startService(ctx)
  const result = await service.delete({ sessionId: 'B' })
  assert.deepEqual(result, { deleted: true })
  assert.deepEqual(state.archivedSessionIds, [])
})

test('future native runtime: delete cleanup calls the official unarchiveSession', async () => {
  writeSessionLog('B')
  const { ctx, state } = makeRc6Context({ archivedSessionIds: ['B'] })
  let unarchiveCalls = 0
  ctx.workspaceRegistry.unarchiveSession = async () => { unarchiveCalls++ }
  const service = startService(ctx)
  const result = await service.delete({ sessionId: 'B' })
  assert.deepEqual(result, { deleted: true })
  assert.equal(unarchiveCalls, 1)
  assert.deepEqual(state.archivedSessionIds, ['B'])
})

test('delete: answers session-not-found when the id is not in the archived set', async () => {
  writeSessionLog('s1')
  const { ctx } = makeWorkspaceContext({ archivedSessionIds: ['s1'] })
  const service = startService(ctx)

  const result = await service.delete({ sessionId: 'not-archived' })

  assert.equal(result.code, 'session-not-found')
  assert.equal(result.sessionId, 'not-archived')
  // Nothing was removed for an id the archive set never held.
  assert.equal(existsSync(fixtureLogPath('s1')), true)
})

test('delete: removes the durable log of one session, keeps the rest, and detaches it from workspace accounting', async () => {
  writeSessionLog('s1', { olderGeneration: true })
  writeSessionLog('s2')
  const workspace = {
    id: 'workspace-a',
    title: 'A',
    path: '/a',
    sessionIds: ['s1', 's2'],
    async detachSession(sessionId: SessionId): Promise<void> {
      workspace.sessionIds = workspace.sessionIds.filter(id => id !== sessionId)
    },
  }
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['s1', 's2'],
    workspaces: [workspace],
  })
  const service = startService(ctx)

  const result = await service.delete({ sessionId: 's1' })

  assert.deepEqual(result, { deleted: true })
  // The log really is gone from disk, every generation of it.
  assert.equal(existsSync(fixtureLogPath('s1')), false)
  assert.equal(existsSync(fixtureLogPath('s1').replace('session.v4', 'session.v3')), false)
  assert.equal(existsSync(fixtureLogPath('s2')), true)
  assert.deepEqual(workspace.sessionIds, ['s2'])
  assert.deepEqual(state.archivedSessionIds, ['s2'])
})

test('delete: second protection inside deleteOne rejects a session that became running after the first check', async () => {
  writeSessionLog('s1')
  let agentChecks = 0
  const { ctx } = makeWorkspaceContext({ archivedSessionIds: ['s1'] })
  ctx.agents.get = () => {
    agentChecks++
    return agentChecks > 1 ? { status: 'running' } : undefined
  }
  const service = startService(ctx)

  const result = await service.delete({ sessionId: 's1' })

  assert.equal(result.code, 'session-running')
  assert.equal(result.sessionId, 's1')
  // The refusal is what keeps a live writer from recreating a headerless log,
  // so the artifact must still be intact.
  assert.equal(existsSync(fixtureLogPath('s1')), true)
})

test('future native runtime: service reports native restore capability', async () => {
  const { ctx } = makeRc6Context()
  ctx.workspaceRegistry.unarchiveSession = async () => {}
  const service = startService(ctx)
  const result = await service.list()
  assert.equal(result.capabilities.restore, 'native')
})

interface FakeWorkspace {
  id: string
  title: string
  path: string
  sessionIds: string[]
  detachSession(sessionId: SessionId): Promise<void> | void
}

function makeWorkspaceContext(initial: {
  archivedSessionIds?: string[]
  workspaces?: FakeWorkspace[]
  headers?: { id: SessionId; createdAt: number; cwd?: string }[]
} = {}) {
  const state: FakeState = {
    workspaceIds: [],
    archivedSessionIds: [...(initial.archivedSessionIds ?? [])],
  }
  const ctx: FakeContext = {
    workspaceRegistry: {
      get archivedSessionIds() {
        return state.archivedSessionIds
      },
      list: () => initial.workspaces ?? [],
      async enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
        return await operation()
      },
      requireState: () => state,
      async setState(next: unknown): Promise<void> {
        Object.assign(state, next as Partial<FakeState>)
      },
    },
    sessionPersistence: {
      root: fixtureRoot(),
      listSnapshots: async () =>
        (initial.archivedSessionIds ?? []).map(id => ({
          header: { id: id as SessionId, createdAt: 1_700_000_000_000, cwd: FIXTURE_CWD },
        })),
      readFrom: async () => ({ events: [] }),
      listArtifacts: async () =>
        (initial.archivedSessionIds ?? []).map(id => ({
          header: fixtureHeader(id),
          path: fixtureLogPath(id),
        })),
    },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    get: () => undefined,
    logger: { warn: () => {} },
    reflect: { provide: () => {} },
  }
  return { ctx, state }
}

test('deleteWorkspace on a runtime without an artifact surface: answers workspace-delete-unsupported', async () => {
  const { ctx } = makeWorkspaceContext({ archivedSessionIds: ['a-1'] })
  delete ctx.sessionPersistence.listArtifacts
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-delete-unsupported')
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['a-1'])
})

test('deleteWorkspace: deletes every archived session in the workspace and returns the count', async () => {
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2', 'b-1'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1', 'a-2'], detachSession: async () => {} },
      { id: 'b', title: 'B', path: '/b', sessionIds: ['b-1'], detachSession: async () => {} },
    ],
  })
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.deepEqual(result, { deleted: true, deletedCount: 2 })
  assert.deepEqual(state.archivedSessionIds, ['b-1'])
})

test('deleteWorkspace: keeps the real Workspace registration and project directory intact', async () => {
  const workspaceA = {
    id: 'a',
    title: 'A',
    path: '/projects/a',
    sessionIds: ['a-1', 'a-2'],
    detachSession: async (sessionId: SessionId) => {
      workspaceA.sessionIds = workspaceA.sessionIds.filter(id => id !== sessionId)
    },
  }
  const workspaceB = {
    id: 'b',
    title: 'B',
    path: '/projects/b',
    sessionIds: ['b-1'],
    detachSession: async () => {},
  }
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2', 'b-1'],
    workspaces: [workspaceA, workspaceB],
  })
  const service = startService(ctx)

  const result = await service.deleteWorkspace({ workspaceId: 'a' })

  assert.deepEqual(result, { deleted: true, deletedCount: 2 })
  // The archived group is gone, but the DSH Workspace registration and its
  // project directory/path remain; only the archived-session accounting was
  // detached.
  const remaining = ctx.workspaceRegistry.list() as FakeWorkspace[]
  assert.equal(remaining.some(workspace => workspace.id === 'a'), true)
  assert.equal(remaining.find(workspace => workspace.id === 'a')?.path, '/projects/a')
  assert.deepEqual(remaining.find(workspace => workspace.id === 'a')?.sessionIds, [])
  assert.deepEqual(remaining.find(workspace => workspace.id === 'b')?.sessionIds, ['b-1'])
  assert.deepEqual(state.archivedSessionIds, ['b-1'])
})

test('deleteWorkspace: aborts the whole group when any session is running', async () => {
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1', 'a-2'], detachSession: async () => {} },
    ],
  })
  ctx.agents.get = (sessionId: SessionId) =>
    sessionId === 'a-1' ? { status: 'running' } : undefined
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-sessions-running')
  assert.equal(result.runningSessionCount, 1)
  assert.equal(result.sessionId, 'a-1')
  assert.equal(typeof result.title, 'string')
  assert.equal(result.title, '会话 a-1')
  assert.deepEqual(state.archivedSessionIds, ['a-1', 'a-2'])
})

test('deleteWorkspace: ungrouped sessions delete when no workspaceId is sent', async () => {
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['u-1', 'u-2', 'a-1'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1'], detachSession: async () => {} },
    ],
  })
  const service = startService(ctx)
  const result = await service.deleteWorkspace({})
  assert.deepEqual(result, { deleted: true, deletedCount: 2 })
  assert.deepEqual(state.archivedSessionIds, ['a-1'])
})

test('deleteWorkspace: empty-string workspaceId is not treated as the ungrouped group', async () => {
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['u-1'],
    workspaces: [],
  })
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: '' })
  assert.deepEqual(result, { deleted: true, deletedCount: 0 })
  assert.deepEqual(state.archivedSessionIds, ['u-1'])
})

test('deleteWorkspace: reports partial progress when a session delete fails', async () => {
  writeSessionLog('a-1')
  writeSessionLog('a-2')
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1', 'a-2'], detachSession: async () => {} },
    ],
  })
  // Fail the second session's path resolution — the boundary where a real
  // filesystem failure would surface.
  const baseListArtifacts = ctx.sessionPersistence.listArtifacts!
  let seen = 0
  ctx.sessionPersistence.listArtifacts = async (signal?: AbortSignal) => {
    seen++
    if (seen > 1) throw new Error('storage boom')
    return await baseListArtifacts(signal)
  }
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-delete-partial')
  assert.equal(result.deletedCount, 1)
  assert.equal(result.failedSessionId, 'a-2')
  assert.deepEqual(state.archivedSessionIds, ['a-2'])
  // The first session's log is really gone; the failed one is untouched.
  assert.equal(existsSync(fixtureLogPath('a-1')), false)
  assert.equal(existsSync(fixtureLogPath('a-2')), true)
})

test('deleteWorkspace: re-checks running state during the loop and reports partial if a session becomes running', async () => {
  writeSessionLog('a-1')
  writeSessionLog('a-2')
  let removals = 0
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1', 'a-2'], detachSession: async () => {} },
    ],
  })
  ctx.agents.get = (sessionId: SessionId) => {
    if (sessionId === 'a-2' && removals > 0) return { status: 'running' }
    return undefined
  }
  const measureRemoval = ctx.sessionPersistence.listArtifacts!
  ctx.sessionPersistence.listArtifacts = async (signal?: AbortSignal) => {
    // Count real removals as they happen, so the loop's re-check observes the
    // same "one was already deleted" state a live runtime would.
    removals++
    return await measureRemoval(signal)
  }
  removals = 0
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-delete-partial')
  assert.equal(result.deletedCount, 1)
  assert.equal(result.failedSessionId, 'a-2')
  assert.deepEqual(state.archivedSessionIds, ['a-2'])
  assert.equal(existsSync(fixtureLogPath('a-1')), false)
  assert.equal(existsSync(fixtureLogPath('a-2')), true)
})

test('deleteWorkspace: aborts with workspace-sessions-running if the first session becomes running before deletion', async () => {
  writeSessionLog('a-1')
  let agentCalls = 0
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1'], detachSession: async () => {} },
    ],
  })
  ctx.agents.get = (sessionId: SessionId) => {
    agentCalls++
    if (sessionId === 'a-1' && agentCalls > 1) return { status: 'running' }
    return undefined
  }
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-sessions-running')
  assert.equal(result.runningSessionCount, 1)
  assert.equal(existsSync(fixtureLogPath('a-1')), true)
  assert.deepEqual(state.archivedSessionIds, ['a-1'])
})

test('deleteWorkspace: rejects a live session in preflight before deleting anything', async () => {
  writeSessionLog('a-1')
  writeSessionLog('a-2')
  writeSessionLog('a-3')
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2', 'a-3'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1', 'a-2', 'a-3'], detachSession: async () => {} },
    ],
  })
  ctx.sessions.get = (sessionId: SessionId) =>
    sessionId === 'a-2' ? { header: { id: sessionId, createdAt: 1 } } as never : undefined
  const service = startService(ctx)

  const result = await service.deleteWorkspace({ workspaceId: 'a' })

  assert.equal(result.code, 'workspace-sessions-running')
  assert.equal(result.runningSessionCount, 1)
  assert.equal(result.sessionId, 'a-2')
  // One live session aborts the whole batch: no partial deletion.
  assert.equal(existsSync(fixtureLogPath('a-1')), true)
  assert.equal(existsSync(fixtureLogPath('a-2')), true)
  assert.equal(existsSync(fixtureLogPath('a-3')), true)
  assert.deepEqual(state.archivedSessionIds, ['a-1', 'a-2', 'a-3'])
})

/**
 * 0.1.5-shaped context: `SessionPersistence` lost `listSnapshots`,
 * `readFrom`, and `delete`; headers come from `list()` (snapshots carrying
 * `header`) and one session's log from `open(id, 'read')` plus a read handle.
 * The registry mutation surface is unchanged, so restore stays `rc6-compat`.
 */
function makeRc15Context(initial: {
  archivedSessionIds?: string[]
  workspaces?: FakeWorkspace[]
  headers?: readonly { id: SessionId; createdAt: number }[]
  events?: readonly unknown[]
  onOpen?: (sessionId: SessionId) => void
  onClose?: (sessionId: SessionId) => void
} = {}) {
  const state: FakeState = {
    workspaceIds: [],
    archivedSessionIds: [...(initial.archivedSessionIds ?? [])],
  }
  const ctx: FakeContext = {
    workspaceRegistry: {
      get archivedSessionIds() {
        return state.archivedSessionIds
      },
      list: () => initial.workspaces ?? [],
      async enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
        return await operation()
      },
      requireState: () => state,
      async setState(next: unknown): Promise<void> {
        Object.assign(state, next as Partial<FakeState>)
      },
    },
    sessionPersistence: {
      list: async () =>
        (initial.headers ?? (initial.archivedSessionIds ?? []).map(id => ({
          id: id as SessionId,
          createdAt: 1_700_000_000_000,
        }))).map(header => ({ header })),
      open: async (sessionId: SessionId) => {
        initial.onOpen?.(sessionId)
        return {
          read: async () => ({ events: initial.events ?? [] }),
          close: async () => { initial.onClose?.(sessionId) },
        }
      },
    },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    get: () => undefined,
    logger: { warn: () => {} },
    reflect: { provide: () => {} },
  }
  return { ctx, state }
}

test('0.1.5 runtime: list() is header-only and details() folds the requested rows', async () => {
  const { ctx } = makeRc15Context({
    archivedSessionIds: ['a-1'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1'], detachSession: async () => {} },
    ],
    events: [
      { type: 'session/title', data: { title: '来自 open 的标题' }, time: 1_700_000_000_500, seq: 0 },
    ],
  })
  const service = startService(ctx)

  const result = await service.list()

  assert.equal(result.capabilities.restore, 'rc6-compat')
  assert.equal(result.capabilities.delete, 'unsupported')
  assert.deepEqual(result.items, [{
    sessionId: 'a-1',
    title: '会话 a-1',
    workspaceId: 'a',
    workspaceTitle: 'A',
    workspacePath: '/a',
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    running: false,
    detailsLoaded: false,
  }])

  const details = await service.details({ sessionIds: ['a-1'] })

  assert.deepEqual(details.items, [{
    sessionId: 'a-1',
    title: '来自 open 的标题',
    lastActivityAt: 1_700_000_000_500,
    detailsLoaded: true,
  }])
})

test('0.1.5 runtime: the read handle is closed even when read() rejects, and the row degrades to header-only', async () => {
  const opened: string[] = []
  const closed: string[] = []
  const { ctx } = makeRc15Context({ archivedSessionIds: ['a-1'], onOpen: id => opened.push(id), onClose: id => closed.push(id) })
  ctx.sessionPersistence.open = async (sessionId: SessionId) => {
    opened.push(sessionId)
    return {
      read: async () => { throw new Error('torn tail') },
      close: async () => { closed.push(sessionId) },
    }
  }
  const service = startService(ctx)

  const details = await service.details({ sessionIds: ['a-1'] })

  assert.deepEqual(opened, ['a-1'])
  assert.deepEqual(closed, ['a-1'])
  // No readable events: the row keeps its id-derived placeholder and says so.
  assert.deepEqual(details.items, [{
    sessionId: 'a-1',
    title: '会话 a-1',
    lastActivityAt: 0,
    detailsLoaded: false,
  }])
})

test('runtime exposing neither listing surface: list answers with a named error instead of an empty list', async () => {
  const { ctx } = makeRc15Context({ archivedSessionIds: ['a-1'] })
  delete ctx.sessionPersistence.list
  const service = startService(ctx)

  await assert.rejects(service.list(), /exposes neither SessionPersistence\.listSnapshots nor SessionPersistence\.list/)
})

test('runtime exposing neither read surface: rows stay header-only', async () => {
  const { ctx } = makeRc15Context({ archivedSessionIds: ['a-1'] })
  delete ctx.sessionPersistence.open
  const service = startService(ctx)

  const result = await service.list()

  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.sessionId, 'a-1')
})

/**
 * Persistence fakes whose read surface is a real method that touches `this`.
 *
 * The shipped JSONL backend reads through instance methods (`open()` begins
 * with `this.ensureRootEncoding()`, `list()` with its own tracker/root state),
 * so a caller that detaches the method from its receiver gets
 * `TypeError: Cannot read properties of undefined`; the listing then silently
 * degrades to header-only rows (`会话 <id 前 8 位>`, last activity = createdAt).
 * Arrow-function fakes cannot see that mistake — these keep the dependency.
 */
class ReceiverSensitivePersistence {
  readonly ids: readonly string[]
  readonly events: readonly unknown[]

  constructor(ids: readonly string[], events: readonly unknown[]) {
    this.ids = ids
    this.events = events
  }

  /** Stored headers, read through `this` like the real backend's listing. */
  async list(): Promise<readonly { header: { id: SessionId; createdAt: number } }[]> {
    return this.ids.map(id => ({ header: { id: id as SessionId, createdAt: 1_700_000_000_000 } }))
  }
}

/** 0.1.7+ read surface: `open(id, 'read')` plus a handle. */
class OpenSurfacePersistence extends ReceiverSensitivePersistence {
  openCalls = 0

  async open(sessionId: SessionId, _access?: 'read'): Promise<{
    read(offset?: number): Promise<{ events: readonly unknown[] }>
    close(): Promise<void>
  }> {
    if (!this.ids.includes(sessionId)) throw new Error(`session "${sessionId}" not found`)
    this.openCalls += 1
    return {
      read: async (offset = 0) => ({ events: this.events.slice(offset) }),
      close: async () => {},
    }
  }
}

/** rc.5–rc.8 read surface: `readFrom(id, 0)`. */
class ReadFromSurfacePersistence extends ReceiverSensitivePersistence {
  readFromCalls = 0

  async readFrom(_sessionId: SessionId, offset: number): Promise<{ events: readonly unknown[] }> {
    this.readFromCalls += 1
    return { events: this.events.slice(offset) }
  }
}

const COLD_ROW_EVENTS = [
  { type: 'user/message', data: { source: { kind: 'user' }, content: ['先读代码'] }, time: 1_700_000_000_100, seq: 0 },
  { type: 'session/title', data: { title: '冷会话标题' }, time: 1_700_000_000_500, seq: 1 },
]

test('listing never reads a stored log: every cold row arrives header-only', async () => {
  const { ctx } = makeRc15Context({ archivedSessionIds: ['a-1', 'a-2'] })
  const persistence = new OpenSurfacePersistence(['a-1', 'a-2'], COLD_ROW_EVENTS)
  ctx.sessionPersistence = persistence
  const service = startService(ctx)

  const result = await service.list()

  assert.equal(persistence.openCalls, 0)
  assert.equal(result.items.length, 2)
  assert.equal(result.items.every(row => row.detailsLoaded === false), true)
  assert.equal(result.items.every(row => row.title === `会话 ${row.sessionId.slice(0, 8)}`), true)
  // Header-only last activity is the creation time, so the default sort is stable.
  assert.equal(result.items.every(row => row.lastActivityAt === row.createdAt), true)
})

test('0.1.7 runtime: the open() read surface keeps its receiver, so a cold row folds its real title', async () => {
  const { ctx } = makeRc15Context({ archivedSessionIds: ['a-1'] })
  const persistence = new OpenSurfacePersistence(['a-1'], COLD_ROW_EVENTS)
  ctx.sessionPersistence = persistence
  const service = startService(ctx)

  const details = await service.details({ sessionIds: ['a-1'] })

  assert.equal(persistence.openCalls, 1)
  assert.deepEqual(details.items, [{
    sessionId: 'a-1',
    title: '冷会话标题',
    // Event times only: the caller applies its own createdAt floor.
    lastActivityAt: 1_700_000_000_500,
    detailsLoaded: true,
  }])
})

test('rc.5-rc.8 runtime: the readFrom() read surface keeps its receiver too', async () => {
  const { ctx } = makeRc6Context({ archivedSessionIds: ['a-1'] })
  const persistence = new ReadFromSurfacePersistence(['a-1'], COLD_ROW_EVENTS)
  ctx.sessionPersistence = persistence
  const service = startService(ctx)

  const details = await service.details({ sessionIds: ['a-1', 'a-1'] })

  assert.equal(persistence.readFromCalls, 1)
  assert.deepEqual(details.items, [{
    sessionId: 'a-1',
    title: '冷会话标题',
    lastActivityAt: 1_700_000_000_500,
    detailsLoaded: true,
  }])
})

test('details hydrates a resident session from memory and ignores unarchived ids', async () => {
  const { ctx } = makeRc15Context({ archivedSessionIds: ['a-1'] })
  const persistence = new OpenSurfacePersistence(['a-1'], COLD_ROW_EVENTS)
  ctx.sessionPersistence = persistence
  ctx.sessions.get = sessionId => sessionId === 'a-1'
    ? {
      header: { id: 'a-1' as SessionId, createdAt: 1_700_000_000_000 },
      snapshotEvents: () => [
        { type: 'session/title', data: { title: '活会话标题' }, time: 1_700_000_000_900, seq: 0 },
      ],
    }
    : undefined
  const service = startService(ctx)

  // 'b-9' is not archived, so hydration must not read it.
  const details = await service.details({ sessionIds: ['a-1', 'b-9'] })

  assert.equal(persistence.openCalls, 0)
  assert.deepEqual(details.items, [{
    sessionId: 'a-1',
    title: '活会话标题',
    lastActivityAt: 1_700_000_000_900,
    detailsLoaded: true,
  }])
})

test('live session: events come from snapshotEvents() when the events getter is absent', async () => {
  const { ctx } = makeRc15Context({ archivedSessionIds: ['a-1'] })
  ctx.sessions.get = sessionId => sessionId === 'a-1'
    ? {
      header: { id: 'a-1' as SessionId, createdAt: 1_700_000_000_000 },
      snapshotEvents: () => [
        { type: 'session/title', data: { title: '活会话标题' }, time: 1_700_000_000_700, seq: 0 },
      ],
    }
    : undefined
  const service = startService(ctx)

  const result = await service.list()

  assert.equal(result.items[0]?.title, '活会话标题')
  assert.equal(result.items[0]?.lastActivityAt, 1_700_000_000_700)
})

test('live session: the legacy events getter still wins when the runtime ships it', async () => {
  const { ctx } = makeRc6Context({ archivedSessionIds: ['a-1'] })
  ctx.sessions.get = sessionId => sessionId === 'a-1'
    ? {
      header: { id: 'a-1' as SessionId, createdAt: 1_700_000_000_000 },
      events: [
        { type: 'session/title', data: { title: '旧 getter 标题' }, time: 1_700_000_000_800, seq: 0 },
      ],
      snapshotEvents: () => [
        { type: 'session/title', data: { title: '不该被用到' }, time: 1_700_000_000_900, seq: 0 },
      ],
    }
    : undefined
  const service = startService(ctx)

  const result = await service.list()

  assert.equal(result.items[0]?.title, '旧 getter 标题')
  assert.equal(result.items[0]?.lastActivityAt, 1_700_000_000_800)
})

/**
 * Workspace-registration removal is a separate action from clearing a group's
 * archived sessions. Its contract: the registration goes, the sessions and the
 * archive set stay — which is exactly the official `WorkspaceRegistry.delete()`
 * semantics the endpoint delegates to.
 */
function makeRegistrationContext(initial: {
  archivedSessionIds?: string[]
  workspaces?: FakeWorkspace[]
  deleteImpl?: (workspaceId: string) => Promise<boolean>
} = {}) {
  const { deleteImpl, ...rest } = initial
  const { ctx, state } = makeWorkspaceContext(rest)
  let deleteCalls = 0
  const deletedIds: string[] = []
  ctx.workspaceRegistry.delete = async (workspaceId: string) => {
    deleteCalls++
    deletedIds.push(workspaceId)
    if (deleteImpl !== undefined) return await deleteImpl(workspaceId)
    return true
  }
  return {
    ctx,
    state,
    deleteCalls: () => deleteCalls,
    deletedIds: () => deletedIds,
  }
}

test('deleteWorkspaceRegistration: removes the registration and reports the capability', async () => {
  const { ctx, deleteCalls, deletedIds } = makeRegistrationContext()
  const service = startService(ctx)

  const list = await service.list()
  assert.equal(list.capabilities.workspaceDelete, 'native')

  const result = await service.deleteWorkspaceRegistration({ workspaceId: 'a' })

  assert.deepEqual(result, { deleted: true, workspaceId: 'a' })
  assert.equal(deleteCalls(), 1)
  assert.deepEqual(deletedIds(), ['a'])
})

test('deleteWorkspaceRegistration: answers workspace-not-found for an unknown id instead of throwing', async () => {
  const { ctx } = makeRegistrationContext({ deleteImpl: async () => false })
  const service = startService(ctx)

  const result = await service.deleteWorkspaceRegistration({ workspaceId: 'ghost' })

  assert.equal(result.code, 'workspace-not-found')
  assert.equal(result.workspaceId, 'ghost')
})

test('deleteWorkspaceRegistration: refuses an empty id without calling the registry', async () => {
  const { ctx, deleteCalls } = makeRegistrationContext()
  const service = startService(ctx)

  const result = await service.deleteWorkspaceRegistration({ workspaceId: '' })

  assert.equal(result.code, 'workspace-not-found')
  assert.equal(deleteCalls(), 0)
})

test('deleteWorkspaceRegistration: answers unsupported on a runtime whose registry has no delete', async () => {
  const { ctx, state } = makeWorkspaceContext({ archivedSessionIds: ['a-1'] })
  const service = startService(ctx)

  const list = await service.list()
  assert.equal(list.capabilities.workspaceDelete, 'unsupported')

  const result = await service.deleteWorkspaceRegistration({ workspaceId: 'a' })

  assert.equal(result.code, 'workspace-registration-delete-unsupported')
  // The archive set is untouched: registration removal is not session deletion.
  assert.deepEqual(state.archivedSessionIds, ['a-1'])
})

test('deleteWorkspaceRegistration: never touches the archive set or session logs', async () => {
  writeSessionLog('a-1')
  const { ctx, state } = makeRegistrationContext({
    archivedSessionIds: ['a-1'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1'], detachSession: async () => {} },
    ],
  })
  const service = startService(ctx)

  const result = await service.deleteWorkspaceRegistration({ workspaceId: 'a' })

  assert.deepEqual(result, { deleted: true, workspaceId: 'a' })
  // Sessions survive as Ungrouped: their logs stay and they stay archived.
  assert.equal(existsSync(fixtureLogPath('a-1')), true)
  assert.deepEqual(state.archivedSessionIds, ['a-1'])
})

test('deleteWorkspaceRegistration: a failing registry write propagates instead of reporting success', async () => {
  const { ctx } = makeRegistrationContext({
    deleteImpl: async () => { throw new Error('registry write failed') },
  })
  const service = startService(ctx)

  await assert.rejects(
    () => service.deleteWorkspaceRegistration({ workspaceId: 'a' }),
    /registry write failed/,
  )
})

test('clearing a group and removing its registration stay independent actions', async () => {
  writeSessionLog('a-1')
  const { ctx, state, deleteCalls } = makeRegistrationContext({
    archivedSessionIds: ['a-1'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1'], detachSession: async () => {} },
    ],
  })
  const service = startService(ctx)

  // Clearing the group's archived sessions must not remove the registration.
  const cleared = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.deepEqual(cleared, { deleted: true, deletedCount: 1 })
  assert.equal(deleteCalls(), 0)

  // And removing the registration must not delete any session.
  writeSessionLog('a-2')
  const second = makeRegistrationContext({ archivedSessionIds: ['a-2'] })
  const secondService = startService(second.ctx)
  await secondService.deleteWorkspaceRegistration({ workspaceId: 'a' })
  assert.equal(existsSync(fixtureLogPath('a-2')), true)
  assert.deepEqual(second.state.archivedSessionIds, ['a-2'])
  assert.deepEqual(state.archivedSessionIds, [])
})
