/**
 * ArchiveCompatibilityAdapter unit tests: capability detection (native /
 * rc.6 / unsupported) and the rc.6 restore primitive.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  ArchiveCompatibilityAdapter,
  RestoreUnsupportedError,
} from '../src/host/compat/restore.ts'
import type { Rc6WorkspaceRegistryCompat } from '../src/host/compat/restore.ts'

interface FakeRegistryState {
  readonly sessionIds: string[]
  archivedSessionIds: string[]
}

const sid = (id: string): SessionId => id as SessionId

/** rc.6-shaped registry fake: no unarchiveSession, registry mutation surface present. */
function rc6Registry(initial: { sessionIds?: string[]; archivedSessionIds?: string[] } = {}) {
  const state: FakeRegistryState = {
    sessionIds: [...(initial.sessionIds ?? [])],
    archivedSessionIds: [...(initial.archivedSessionIds ?? [])],
  }
  const calls: { operation: 'enqueue' | 'setState'; arg?: unknown }[] = []
  const registry: Rc6WorkspaceRegistryCompat & { readonly archiveState: () => FakeRegistryState } = {
    get archivedSessionIds() {
      return state.archivedSessionIds
    },
    async enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
      calls.push({ operation: 'enqueue' })
      return await operation()
    },
    requireState() {
      return state as unknown as ReturnType<Rc6WorkspaceRegistryCompat['requireState']>
    },
    async setState(next: unknown): Promise<void> {
      calls.push({ operation: 'setState', arg: next })
      Object.assign(state, next as Partial<FakeRegistryState>)
    },
    archiveState: () => state,
  }
  return { registry, state, calls }
}

test('rc.6 runtime (no unarchiveSession, mutation surface present) → rc6-compat', () => {
  const { registry } = rc6Registry()
  const adapter = new ArchiveCompatibilityAdapter(registry)
  assert.equal(adapter.getRestoreCapability(), 'rc6-compat')
})

test('future native runtime (unarchiveSession present) → native, rc.6 fallback never runs', async () => {
  const { registry: rc6, calls } = rc6Registry()
  const unarchiveSession = async () => {}
  const registry = Object.assign(rc6, { unarchiveSession })
  const adapter = new ArchiveCompatibilityAdapter(registry)
  assert.equal(adapter.getRestoreCapability(), 'native')

  await adapter.restore(sid('B'))
  // The rc.6 mutation path must not have executed.
  assert.deepEqual(calls, [])
})

test('unknown runtime (one mutation method missing) → unsupported, construction does not throw', async () => {
  const { registry } = rc6Registry()
  const partial = { ...registry }
  delete (partial as Partial<typeof registry>).setState
  const adapter = new ArchiveCompatibilityAdapter(partial)
  assert.equal(adapter.getRestoreCapability(), 'unsupported')
  await assert.rejects(
    () => adapter.restore(sid('B')),
    (error: unknown) => error instanceof RestoreUnsupportedError && error.sessionId === 'B',
  )
})

test('unknown runtime (registry missing entirely) → unsupported', () => {
  const adapter = new ArchiveCompatibilityAdapter(undefined)
  assert.equal(adapter.getRestoreCapability(), 'unsupported')
})

test('rc.6 restore removes the id from the archive set and leaves session accounting untouched', async () => {
  const { registry, state } = rc6Registry({ sessionIds: ['A', 'B', 'C'], archivedSessionIds: ['B'] })
  const adapter = new ArchiveCompatibilityAdapter(registry)
  await adapter.restore(sid('B'))
  assert.deepEqual(state.sessionIds, ['A', 'B', 'C'])
  assert.deepEqual(state.archivedSessionIds, [])
})

test('rc.6 restore is idempotent — a second restore is a no-op', async () => {
  const { registry, state } = rc6Registry({ sessionIds: ['A', 'B', 'C'], archivedSessionIds: ['B'] })
  const adapter = new ArchiveCompatibilityAdapter(registry)
  await adapter.restore(sid('B'))
  await adapter.restore(sid('B'))
  assert.deepEqual(state.archivedSessionIds, [])
})

test('rc.6 restore goes through the registry mutation chain (enqueue → require → set)', async () => {
  const { registry, calls } = rc6Registry({ sessionIds: ['A', 'B', 'C'], archivedSessionIds: ['B'] })
  const adapter = new ArchiveCompatibilityAdapter(registry)
  await adapter.restore(sid('B'))
  assert.ok(calls.some(call => call.operation === 'enqueue'))
  const setCall = calls.find(call => call.operation === 'setState')
  assert.ok(setCall !== undefined)
  const written = setCall.arg as { archivedSessionIds?: readonly string[]; sessionIds?: readonly string[] }
  assert.deepEqual(written.archivedSessionIds, [])
  // Only the archive set is rewritten; the rest of the state is spread through.
  assert.deepEqual(written.sessionIds, ['A', 'B', 'C'])
})

test('removeFromArchiveSet on native runtime calls the official unarchiveSession', async () => {
  const { registry } = rc6Registry({ archivedSessionIds: ['B'] })
  let called = 0
  const adapter = new ArchiveCompatibilityAdapter(Object.assign(registry, {
    unarchiveSession: async () => { called++ },
  }))
  await adapter.removeFromArchiveSet('B' as SessionId)
  assert.equal(called, 1)
})

test('removeFromArchiveSet on unsupported runtime is a no-op (delete cleanup must not throw)', async () => {
  const { registry } = rc6Registry()
  const partial = { ...registry }
  delete (partial as Partial<typeof registry>).enqueueOperation
  const adapter = new ArchiveCompatibilityAdapter(partial)
  await adapter.removeFromArchiveSet('B' as SessionId)
})
