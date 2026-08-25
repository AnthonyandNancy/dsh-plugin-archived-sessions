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

interface FakeContext {
  workspaceRegistry: Record<string, unknown> & {
    readonly archivedSessionIds: readonly SessionId[]
    list(): unknown[]
  }
  sessionPersistence: {
    listSnapshots(): Promise<readonly { header: { id: SessionId; createdAt: number } }[]>
    readFrom(): Promise<{ events: readonly unknown[] }>
    delete?: (sessionId: SessionId) => Promise<void>
  }
  sessions: { get(): undefined }
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

test('runtime without SessionPersistence.delete: service refuses to start', async () => {
  const { ctx } = makeRc6Context()
  delete ctx.sessionPersistence.delete
  assert.throws(
    () => startService(ctx),
    /requires a DSH runtime with SessionPersistence.delete support/,
  )
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
