/**
 * ArchivedSessionsStore unit tests: no-flash background refresh, restore
 * without pagination resets, pessimistic removal, capability flow, and
 * failure modes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ArchivedSessionsStore, ARCHIVED_SESSIONS_PAGE_SIZE } from '../src/client/store.ts'
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

function listResult(count: number, capabilities: ArchivedSessionsCapabilities = CAPABILITIES): ArchivedSessionListResult {
  return { items: Array.from({ length: count }, (_, index) => makeItem(index)), capabilities }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeRemote(overrides: Partial<ArchivedSessionsRemote> = {}): ArchivedSessionsRemote & {
  listCalls: () => number
} {
  let listCalls = 0
  const remote: ArchivedSessionsRemote & { listCalls: () => number } = {
    list: async () => ({ ok: true, value: listResult(0) }),
    restore: async () => ({ ok: true, value: { restored: true } }),
    delete: async () => ({ ok: true, value: { deleted: true } }),
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
  assert.equal(state.loadedCount, ARCHIVED_SESSIONS_PAGE_SIZE)
  assert.deepEqual(state.capabilities, { restore: 'unsupported', delete: 'unsupported' })
})

test('first load: caps at page size and surfaces host capabilities', async () => {
  const store = new ArchivedSessionsStore(makeRemote({ list: async () => ({ ok: true, value: listResult(60) }) }))
  await store.refresh()
  const state = store.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.refreshing, false)
  assert.equal(state.items.length, 60)
  assert.equal(state.loadedCount, ARCHIVED_SESSIONS_PAGE_SIZE)
  assert.deepEqual(state.capabilities, CAPABILITIES)
})

test('background refresh does not flash: rows, loadedCount and status stay put while refreshing', async () => {
  const remote = makeRemote({ list: async () => ({ ok: true, value: listResult(60) }) })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()
  for (let index = 1; index < 60; index++) store.loadMore()

  const gate = deferred<{ ok: true; value: ArchivedSessionListResult }>()
  remote.list = () => gate.promise
  const pending = store.refresh()
  const during = store.getSnapshot()
  assert.equal(during.status, 'ready')
  assert.equal(during.refreshing, true)
  assert.equal(during.items.length, 60)
  assert.equal(during.loadedCount, 60)
  assert.equal(during.filter, '')
  assert.equal(during.sort, 'lastActivity')

  gate.resolve({ ok: true, value: listResult(60) })
  await pending
  const after = store.getSnapshot()
  assert.equal(after.status, 'ready')
  assert.equal(after.refreshing, false)
  assert.equal(after.items.length, 60)
  assert.equal(after.loadedCount, 60)
})

test('restore removes only the restored row, keeps pagination, and never reloads the list', async () => {
  const remote = makeRemote({ list: async () => ({ ok: true, value: listResult(60) }) })
  const store = new ArchivedSessionsStore(remote)
  await store.refresh()
  for (let index = 1; index < 60; index++) store.loadMore()

  await store.restore('session-34')
  const state = store.getSnapshot()
  assert.equal(state.items.length, 59)
  assert.equal(state.items.some(item => item.sessionId === 'session-34'), false)
  assert.equal(state.loadedCount, 59)
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
  for (let index = 1; index < 60; index++) store.loadMore()

  const gate = deferred<{ ok: false; error: { code: string; message: string; details: object } }>()
  remote.list = () => gate.promise as never
  const pending = store.refresh()
  gate.resolve({ ok: false, error: { code: 'transport', message: 'boom', details: {} } })
  await pending

  const state = store.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.refreshing, false)
  assert.equal(state.items.length, 60)
  assert.equal(state.loadedCount, 60)
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
