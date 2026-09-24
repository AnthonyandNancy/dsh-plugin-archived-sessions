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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ArchivedSessionsService } from '../lib/types/index.js'

interface FakeState {
  readonly workspaceIds: string[]
  archivedSessionIds: string[]
}

interface FakeLiveSession {
  header: { id: SessionId; createdAt: number }
  events?: readonly unknown[]
  snapshotEvents?(): readonly unknown[]
}

/** Storage surfaces of one DSH build; the service probes whichever exist. */
interface FakeSessionPersistence {
  listSnapshots?(): Promise<readonly { header: { id: SessionId; createdAt: number } }[]>
  list?(): Promise<readonly { header: { id: SessionId; createdAt: number } }[]>
  readFrom?(): Promise<{ events: readonly unknown[] }>
  open?(sessionId: SessionId, access: 'read'): Promise<{
    read(offset?: number): Promise<{ events: readonly unknown[] }>
    close(): Promise<void>
  }>
  delete?: (sessionId: SessionId) => Promise<void>
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
      listSnapshots: async () => [],
      readFrom: async () => ({ events: [] }),
      delete: async () => {},
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
  assert.deepEqual(result.items, [])
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

test('runtime without SessionPersistence.delete: service starts, reports delete unsupported, and answers delete-unsupported', async () => {
  const { ctx } = makeRc6Context()
  delete ctx.sessionPersistence.delete
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
  const { ctx, state } = makeRc6Context({ archivedSessionIds: ['B'] })
  const service = startService(ctx)
  const result = await service.delete({ sessionId: 'B' })
  assert.deepEqual(result, { deleted: true })
  assert.deepEqual(state.archivedSessionIds, [])
})

test('future native runtime: delete cleanup calls the official unarchiveSession', async () => {
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
  const { ctx } = makeWorkspaceContext({ archivedSessionIds: ['s1'] })
  let deleteCalls = 0
  ctx.sessionPersistence.delete = async () => { deleteCalls++ }
  const service = startService(ctx)

  const result = await service.delete({ sessionId: 'not-archived' })

  assert.equal(result.code, 'session-not-found')
  assert.equal(result.sessionId, 'not-archived')
  assert.equal(deleteCalls, 0)
})

test('delete: removes one session, keeps the rest, and detaches it from workspace accounting', async () => {
  const deleted: string[] = []
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
  ctx.sessionPersistence.delete = async (sessionId: SessionId) => {
    deleted.push(sessionId as string)
  }
  const service = startService(ctx)

  const result = await service.delete({ sessionId: 's1' })

  assert.deepEqual(result, { deleted: true })
  assert.deepEqual(deleted, ['s1'])
  assert.deepEqual(workspace.sessionIds, ['s2'])
  assert.deepEqual(state.archivedSessionIds, ['s2'])
})

test('delete: second protection inside deleteOne rejects a session that became running after the first check', async () => {
  let agentChecks = 0
  let deleteCalls = 0
  const { ctx } = makeWorkspaceContext({ archivedSessionIds: ['s1'] })
  ctx.agents.get = () => {
    agentChecks++
    return agentChecks > 1 ? { status: 'running' } : undefined
  }
  ctx.sessionPersistence.delete = async () => {
    deleteCalls++
  }
  const service = startService(ctx)

  const result = await service.delete({ sessionId: 's1' })

  assert.equal(result.code, 'session-running')
  assert.equal(result.sessionId, 's1')
  assert.equal(deleteCalls, 0)
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
      listSnapshots: async () =>
        (initial.archivedSessionIds ?? []).map(id => ({
          header: { id: id as SessionId, createdAt: 1_700_000_000_000 },
        })),
      readFrom: async () => ({ events: [] }),
      delete: async () => {},
    },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    get: () => undefined,
    logger: { warn: () => {} },
    reflect: { provide: () => {} },
  }
  return { ctx, state }
}

test('deleteWorkspace on runtime without SessionPersistence.delete: answers workspace-delete-unsupported', async () => {
  const { ctx } = makeWorkspaceContext({ archivedSessionIds: ['a-1'] })
  delete ctx.sessionPersistence.delete
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
  let deleteCalls = 0
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1', 'a-2'], detachSession: async () => {} },
    ],
  })
  ctx.sessionPersistence.delete = async (sessionId: SessionId) => {
    deleteCalls++
    if (sessionId === 'a-2') throw new Error('storage boom')
  }
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-delete-partial')
  assert.equal(result.deletedCount, 1)
  assert.equal(result.failedSessionId, 'a-2')
  assert.deepEqual(state.archivedSessionIds, ['a-2'])
})

test('deleteWorkspace: re-checks running state during the loop and reports partial if a session becomes running', async () => {
  let deleteCalls = 0
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1', 'a-2'], detachSession: async () => {} },
    ],
  })
  ctx.agents.get = (sessionId: SessionId) => {
    if (sessionId === 'a-2' && deleteCalls > 0) return { status: 'running' }
    return undefined
  }
  ctx.sessionPersistence.delete = async () => {
    deleteCalls++
  }
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-delete-partial')
  assert.equal(result.deletedCount, 1)
  assert.equal(result.failedSessionId, 'a-2')
  assert.equal(deleteCalls, 1)
  assert.deepEqual(state.archivedSessionIds, ['a-2'])
})

test('deleteWorkspace: aborts with workspace-sessions-running if the first session becomes running before deletion', async () => {
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
  ctx.sessionPersistence.delete = async () => {
    throw new Error('should not be called')
  }
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-sessions-running')
  assert.equal(result.runningSessionCount, 1)
  assert.deepEqual(state.archivedSessionIds, ['a-1'])
})

test('deleteWorkspace: rejects a live session in preflight before deleting anything', async () => {
  let deleteCalls = 0
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['a-1', 'a-2', 'a-3'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1', 'a-2', 'a-3'], detachSession: async () => {} },
    ],
  })
  ctx.sessions.get = (sessionId: SessionId) =>
    sessionId === 'a-2' ? { header: { id: sessionId, createdAt: 1 } } as never : undefined
  ctx.sessionPersistence.delete = async () => { deleteCalls++ }
  const service = startService(ctx)

  const result = await service.deleteWorkspace({ workspaceId: 'a' })

  assert.equal(result.code, 'workspace-sessions-running')
  assert.equal(result.runningSessionCount, 1)
  assert.equal(result.sessionId, 'a-2')
  assert.equal(deleteCalls, 0)
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

test('0.1.5 runtime: lists through list() + open() and reports delete unsupported', async () => {
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
  assert.deepEqual(result.items.map(row => ({
    sessionId: row.sessionId,
    title: row.title,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
  })), [{
    sessionId: 'a-1',
    title: '来自 open 的标题',
    workspaceId: 'a',
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_500,
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

  const result = await service.list()

  assert.deepEqual(opened, ['a-1'])
  assert.deepEqual(closed, ['a-1'])
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.sessionId, 'a-1')
  // No readable events: the title falls back to the session id prefix.
  assert.equal(result.items[0]?.title, '会话 a-1')
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
