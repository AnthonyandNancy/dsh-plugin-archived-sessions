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
  agents: { get(): undefined }
  get(): undefined
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

test('unknown runtime: delete answers delete-unsupported as a domain result', async () => {
  const { ctx } = makeRc6Context()
  delete ctx.sessionPersistence.delete
  const service = startService(ctx)
  const result = await service.delete({ sessionId: 'B' })
  assert.equal(result.code, 'delete-unsupported')
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

test('future native runtime: service reports native restore capability', async () => {
  const { ctx } = makeRc6Context()
  ctx.workspaceRegistry.unarchiveSession = async () => {}
  const service = startService(ctx)
  const result = await service.list()
  assert.equal(result.capabilities.restore, 'native')
})
