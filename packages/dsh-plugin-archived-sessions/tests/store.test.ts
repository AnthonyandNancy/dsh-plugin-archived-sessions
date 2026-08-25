/**
 * ArchivedSessionsStore and workspace-grouping unit tests: no-flash
 * background refresh, restore without pagination resets, pessimistic
 * removal, capability flow, failure modes, and the first-screen invariant
 * that all workspace headers derive from the complete item list.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ArchivedSessionsStore } from '../src/client/store.ts'
import { groupByWorkspace } from '../src/client/groupByWorkspace.ts'
import type { ArchivedSessionsRemote } from '../src/client/store.ts'
import type {
  ArchivedSessionItem,
  ArchivedSessionListResult,
  ArchivedSessionsCapabilities,
} from '../src/types.ts'

const CAPABILITIES: ArchivedSessionsCapabilities = { restore: 'rc6-compat', delete: 'native' }

function makeItem(index: number): ArchivedSessionItem {
  return {
    sessionId: `session-${index}`,
    title: `会话 ${index}`,
    createdAt: 1_700_000_000_000 + index,
    lastActivityAt: 1_700_000_000_000 + index,
    running: false,
  }
}

function makeWorkspaceItem(workspaceId: string, title: string, order: number): ArchivedSessionItem {
  return {
    sessionId: `${workspaceId}-${order}`,
    title,
    workspaceId,
    workspaceTitle: workspaceId,
    createdAt: 1_700_000_000_000 + order,
    lastActivityAt: 1_700_000_000_000 + order,
    running: false,
  }
}

function listResult(count: number, capabilities: ArchivedSessionsCapabilities = CAPABILITIES): ArchivedSessionListResult {
  return { items: Array.from({ length: count }, (_, index) => makeItem(index)), capabilities }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function captureRejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  assert.fail('expected promise to reject')
}

function makeRemote(overrides: Partial<ArchivedSessionsRemote> = {}): ArchivedSessionsRemote & {
  listCalls: () => number
} {
  let listCalls = 0
  const remote: ArchivedSessionsRemote & { listCalls: () => number } = {
    list: async () => ({ ok: true, value: listResult(0) }),
    restore: async () => ({ ok: true, value: { restored: true } }),
    delete: async () => ({ ok: true, value: { deleted: true } }),
    deleteWorkspace: async () => ({ ok: true, value: { deleted: true, deletedCount: 0 } }),
    ...overrides,
    listCalls: () => listCalls,
  }
  const originalList = remote.list
  remote.list = async (...args) => {
    listCalls++
    return await originalList(...args)
  }
  return remote
}

test('initial state: full loading, not refreshing, capabilities unknown until first list', () => {
  const store = new ArchivedSessionsStore(makeRemote())
  const state = store.getSnapshot()
  assert.equal(state.status, 'loading')
  assert.equal(state.refreshing, false)
  assert.deepEqual(state.items, [])
  assert.deepEqual(state.capabilities, { restore: 'unsupported', delete: 'unsupported' })
})

test('first load keeps the full fetched list and surfaces host capabilities', async () => {
  const store = new ArchivedSessionsStore(makeRemote({ list: async () => ({ ok: true, value: listResult(60) }) }))
  await store.refresh()
  const state = store.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.refreshing, false)
  assert.equal(state.items.length, 60)
  assert.deepEqual(state.capabilities, CAPABILITIES)
})

test('background refresh does not flash: rows and status stay put while refreshing', async () => {
  const remote = makeRemote({ list: async () => ({ ok: true, value: listResult(60) }) })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()

  const gate = deferred<{ ok: true; value: ArchivedSessionListResult }>()
  remote.list = () => gate.promise
  const pending = store.refresh()
  const during = store.getSnapshot()
  assert.equal(during.status, 'ready')
  assert.equal(during.refreshing, true)
  assert.equal(during.items.length, 60)
  assert.equal(during.filter, '')
  assert.equal(during.sort, 'lastActivity')

  gate.resolve({ ok: true, value: listResult(60) })
  await pending
  const after = store.getSnapshot()
  assert.equal(after.status, 'ready')
  assert.equal(after.refreshing, false)
  assert.equal(after.items.length, 60)
})

test('restore removes only the restored row and never reloads the list', async () => {
  const remote = makeRemote({ list: async () => ({ ok: true, value: listResult(60) }) })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()

  await store.restore('session-34')
  const state = store.getSnapshot()
  assert.equal(state.items.length, 59)
  assert.equal(state.items.some(item => item.sessionId === 'session-34'), false)
  assert.equal(state.status, 'ready')
  assert.equal(state.refreshing, false)
  assert.equal(remote.listCalls(), 1)
})

test('restore of an already-restored id is a no-op after the first removal', async () => {
  const remote = makeRemote({ list: async () => ({ ok: true, value: listResult(10) }) })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()
  await store.restore('session-3')
  await store.restore('session-3')
  assert.equal(store.getSnapshot().items.length, 9)
})

test('restore surfaces restore-unsupported as a normal error and keeps the row', async () => {
  const remote = makeRemote({
    list: async () => ({ ok: true, value: listResult(10) }),
    restore: async () => ({
      ok: true,
      value: { code: 'restore-unsupported', sessionId: 'session-3', message: 'restore is unavailable on this DSH runtime' },
    }),
  })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()
  await assert.rejects(() => store.restore('session-3'), /restore is unavailable/)
  assert.equal(store.getSnapshot().items.length, 10)
})

test('background refresh failure keeps current rows visible and records the error', async () => {
  const remote = makeRemote({ list: async () => ({ ok: true, value: listResult(60) }) })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()

  const gate = deferred<{ ok: false; error: { code: string; message: string; details: object } }>()
  remote.list = () => gate.promise as never
  const pending = store.refresh()
  gate.resolve({ ok: false, error: { code: 'transport', message: 'boom', details: {} } })
  await pending

  const state = store.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.refreshing, false)
  assert.equal(state.items.length, 60)
  assert.equal(state.error, 'boom')
})

test('first load failure enters the error state', async () => {
  const store = new ArchivedSessionsStore(makeRemote({
    list: async () => ({ ok: false, error: { code: 'transport', message: 'boom', details: {} } }),
  }))
  await store.refresh()
  const state = store.getSnapshot()
  assert.equal(state.status, 'error')
  assert.equal(state.refreshing, false)
  assert.equal(state.error, 'boom')
})

test('retry after a failed first load goes back through the full loading state', async () => {
  let calls = 0
  const store = new ArchivedSessionsStore(makeRemote({
    list: async () => {
      calls++
      if (calls === 1) return { ok: false, error: { code: 'transport', message: 'boom', details: {} } }
      return { ok: true, value: listResult(5) }
    },
  }))
  await store.refresh()
  const pending = store.refresh()
  assert.equal(store.getSnapshot().status, 'loading')
  await pending
  assert.equal(store.getSnapshot().status, 'ready')
})

test('grouping: shows every archived workspace before any load-more interaction', () => {
  const items = [
    ...Array.from({ length: 19 }, (_, index) => makeWorkspaceItem('a', `A ${index}`, index)),
    ...Array.from({ length: 19 }, (_, index) => makeWorkspaceItem('b', `B ${index}`, 100 + index)),
    ...Array.from({ length: 19 }, (_, index) => makeWorkspaceItem('c', `C ${index}`, 200 + index)),
    ...Array.from({ length: 19 }, (_, index) => makeWorkspaceItem('d', `D ${index}`, 300 + index)),
    ...Array.from({ length: 19 }, (_, index) => makeWorkspaceItem('e', `E ${index}`, 400 + index)),
  ]

  const groups = groupByWorkspace(items, 'Unknown workspace')

  assert.equal(groups.length, 5)
  assert.deepEqual(groups.map(group => group.key), ['a', 'b', 'c', 'd', 'e'])
  assert.ok(groups.every(group => group.items.length === 19))
})

test('grouping: a single workspace with more than one batch does not hide later workspace headers', () => {
  const items = [
    ...Array.from({ length: 100 }, (_, index) => makeWorkspaceItem('a', `A ${index}`, index)),
    makeWorkspaceItem('b', 'B', 1000),
    makeWorkspaceItem('c', 'C', 1001),
    makeWorkspaceItem('d', 'D', 1002),
  ]

  const groups = groupByWorkspace(items, 'Unknown workspace')

  assert.equal(groups.length, 4)
  assert.deepEqual(groups.map(group => group.key), ['a', 'b', 'c', 'd'])
  assert.equal(groups[0]?.items.length, 100)
})

test('grouping: groups follow the first occurrence order of the sorted item list', () => {
  const items = [
    makeWorkspaceItem('z', 'Z newest', 5),
    makeWorkspaceItem('a', 'A older', 1),
    makeWorkspaceItem('z', 'Z older', 4),
    makeWorkspaceItem('m', 'M middle', 3),
  ]

  const groups = groupByWorkspace(items, 'Unknown workspace')

  assert.deepEqual(groups.map(group => group.key), ['z', 'a', 'm'])
  assert.deepEqual(groups[0]?.items.map(item => item.title), ['Z newest', 'Z older'])
})

test('grouping: 100 workspaces are all present without load-more interaction', () => {
  const items = Array.from({ length: 100 }, (_, index) => makeWorkspaceItem(`workspace-${index}`, `Workspace ${index}`, index))

  const groups = groupByWorkspace(items, 'Unknown workspace')

  assert.equal(groups.length, 100)
  assert.equal(new Set(groups.map(group => group.key)).size, 100)
})

test('deleteWorkspace removes the whole workspace group without reloading', async () => {
  const items = [
    makeWorkspaceItem('a', 'A-1', 1),
    makeWorkspaceItem('a', 'A-2', 2),
    makeWorkspaceItem('b', 'B-1', 3),
    makeItem(4),
  ]
  const remote = makeRemote({
    list: async () => ({ ok: true, value: { items, capabilities: CAPABILITIES } }),
  })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()
  await store.deleteWorkspace('a')
  const state = store.getSnapshot()
  assert.equal(state.items.length, 2)
  assert.equal(state.items.some(item => item.workspaceId === 'a'), false)
  assert.equal(remote.listCalls(), 1)
})

test('deleteWorkspace removes ungrouped sessions when workspaceId is undefined', async () => {
  const items = [
    makeWorkspaceItem('a', 'A-1', 1),
    makeItem(2),
    makeItem(3),
  ]
  const store = new ArchivedSessionsStore(makeRemote({
    list: async () => ({ ok: true, value: { items, capabilities: CAPABILITIES } }),
  }))
  await store.refresh()
  await store.deleteWorkspace(undefined)
  const state = store.getSnapshot()
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0]?.workspaceId, 'a')
})

test('deleteWorkspace surfaces running abort with code and count and keeps the list', async () => {
  const items = [makeWorkspaceItem('a', 'A-1', 1)]
  const store = new ArchivedSessionsStore(makeRemote({
    list: async () => ({ ok: true, value: { items, capabilities: CAPABILITIES } }),
    deleteWorkspace: async () => ({
      ok: true,
      value: { code: 'workspace-sessions-running', runningSessionCount: 1, message: 'session is running' },
    }),
  }))
  await store.refresh()
  const error = await captureRejection(() => store.deleteWorkspace('a'))
  assert.equal((error as { code?: string }).code, 'workspace-sessions-running')
  assert.equal((error as { runningSessionCount?: number }).runningSessionCount, 1)
  assert.equal(store.getSnapshot().items.length, 1)
})

test('deleteWorkspace surfaces partial failure metadata and refreshes the list', async () => {
  const items = [
    makeWorkspaceItem('a', 'A-1', 1),
    makeWorkspaceItem('a', 'A-2', 2),
  ]
  const remote = makeRemote({
    list: async () => {
      if (remote.listCalls() === 1) {
        return { ok: true, value: { items, capabilities: CAPABILITIES } }
      }
      return { ok: true, value: { items: [items[1]!], capabilities: CAPABILITIES } }
    },
    deleteWorkspace: async () => ({
      ok: true,
      value: { code: 'workspace-delete-partial', deletedCount: 1, failedSessionId: 'A-1', message: 'partial' },
    }),
  })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()
  const error = await captureRejection(() => store.deleteWorkspace('a'))
  assert.equal((error as { code?: string }).code, 'workspace-delete-partial')
  assert.equal((error as { deletedCount?: number }).deletedCount, 1)
  assert.equal(remote.listCalls(), 2) // initial refresh + fresh reconciliation refresh
  const state = store.getSnapshot()
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0]?.sessionId, 'a-2')
})

test('deleteWorkspace surfaces workspace-delete-unsupported with code', async () => {
  const store = new ArchivedSessionsStore(makeRemote({
    deleteWorkspace: async () => ({
      ok: true,
      value: { code: 'workspace-delete-unsupported', message: 'unsupported' },
    }),
  }))
  const error = await captureRejection(() => store.deleteWorkspace('a'))
  assert.equal((error as { code?: string }).code, 'workspace-delete-unsupported')
})

test('deleteWorkspace surfaces transport failure', async () => {
  const store = new ArchivedSessionsStore(makeRemote({
    deleteWorkspace: async () => ({
      ok: false,
      error: { code: 'transport', message: 'boom', details: {} },
    }),
  }))
  await assert.rejects(() => store.deleteWorkspace('a'), /boom/)
})

