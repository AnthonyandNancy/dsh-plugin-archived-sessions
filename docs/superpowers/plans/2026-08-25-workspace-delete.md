# 工作区批量删除归档会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在“归档会话”设置页为每个工作区组（含“未知工作区”）新增“删除工作区”操作，永久删除该组全部归档会话，但保留工作区注册。

**Architecture:** 新增 Host Remote `deleteWorkspace`（方案 B），服务端复用现有单条删除核心（抽成 `deleteOne`）完成运行中检查与批量删除；客户端 Store 新增 `deleteWorkspace(workspaceId?)` 并在成功后整组移除本地行；UI 在组头增加 RiskConfirmation 确认入口，搜索状态下隐藏按钮。

**Tech Stack:** TypeScript, React 18, DSH Typert Remote, node:test, pnpm workspace。

## Global Constraints

- 插件绝不直接写会话/存储文件（static.test 强制）。
- 缺失能力时返回 domain result，不允许启动硬失败；能力检测只允许 `typeof` 探测，禁止版本字符串比较。
- 现有单条 `delete` 行为保持不变。
- “未知工作区”组（无 `workspaceId`）也必须支持批量删除。
- 搜索状态下隐藏“删除工作区”按钮，防止误删过滤子集。
- 运行中的归档会话存在时整组中止，一个都不删。
- zh 为文案源语言，en 同步翻译；`ArchivedSessionsKey` 由 `zh` 推断。
- 测试命令：`pnpm --filter dsh-plugin-archived-sessions run test`；构建命令：`pnpm --filter dsh-plugin-archived-sessions run build`。

---

### Task 1: Host `deleteWorkspace` 端点 + 服务测试

**Files:**
- Modify: `packages/dsh-plugin-archived-sessions/src/types.ts`
- Modify: `packages/dsh-plugin-archived-sessions/src/index.ts`
- Test: `packages/dsh-plugin-archived-sessions/tests/service.test.ts`

**Interfaces:**
- Consumes: 现有 `ArchivedSessionsService`、`ArchiveCompatibilityAdapter`、`SessionId`。
- Produces:
  - `ArchivedWorkspaceDeleteRequest { readonly workspaceId?: string }`
  - `ArchivedWorkspaceDeleteResult { readonly deleted: true; readonly deletedCount: number }`
  - `ArchivedWorkspaceRunningError { code: 'workspace-sessions-running'; workspaceId?: string; runningSessionCount: number; message: string }`
  - `ArchivedWorkspaceDeleteUnsupportedError { code: 'workspace-delete-unsupported'; workspaceId?: string; message: string }`
  - `ArchivedWorkspaceDeletePartialError { code: 'workspace-delete-partial'; workspaceId?: string; deletedCount: number; failedSessionId: string; message: string }`
  - `ArchivedWorkspaceDeleteValue = 上述四者联合`
  - `ArchivedSessionsService.deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<ArchivedWorkspaceDeleteValue>`
  - 私有 `collectItems(): Promise<ArchivedSessionItem[]>`、`deleteOne(sessionId: SessionId): Promise<void>`

- [ ] **Step 1: 在 `tests/service.test.ts` 追加失败的测试**

在文件末尾追加以下 helper 与测试（`FakeWorkspace` 接口放在 `FakeContext` 之后）：

```ts
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
  assert.deepEqual(state.archivedSessionIds, ['a-1', 'a-2'])
})

test('deleteWorkspace: ungrouped sessions delete when no workspaceId is sent', async () => {
  const { ctx, state } = makeWorkspaceContext({
    archivedSessionIds: ['u-1', 'a-1'],
    workspaces: [
      { id: 'a', title: 'A', path: '/a', sessionIds: ['a-1'], detachSession: async () => {} },
    ],
  })
  const service = startService(ctx)
  const result = await service.deleteWorkspace({})
  assert.deepEqual(result, { deleted: true, deletedCount: 1 })
  assert.deepEqual(state.archivedSessionIds, ['a-1'])
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

test('deleteWorkspace: answers workspace-delete-unsupported when persistence delete is missing', async () => {
  const { ctx } = makeWorkspaceContext({ archivedSessionIds: ['a-1'] })
  delete ctx.sessionPersistence.delete
  const service = startService(ctx)
  const result = await service.deleteWorkspace({ workspaceId: 'a' })
  assert.equal(result.code, 'workspace-delete-unsupported')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-plugin-archived-sessions run test`
Expected: FAIL，报 `service.deleteWorkspace is not a function`（或等价运行时错误）。

- [ ] **Step 3: 实现 `types.ts` 与 `index.ts`**

在 `src/types.ts` 的 `ArchivedSessionDeleteUnsupportedError` 之后追加：

```ts
/** One workspace group's bulk delete request. `workspaceId` omitted targets ungrouped archived sessions (未知工作区). */
export interface ArchivedWorkspaceDeleteRequest {
  readonly workspaceId?: string
}

export interface ArchivedWorkspaceDeleteResult {
  readonly deleted: true
  readonly deletedCount: number
}

/** Business failure used by workspace delete when any session in the group is running. */
export interface ArchivedWorkspaceRunningError {
  readonly code: 'workspace-sessions-running'
  readonly workspaceId?: string
  readonly runningSessionCount: number
  readonly message: string
}

export interface ArchivedWorkspaceDeleteUnsupportedError {
  readonly code: 'workspace-delete-unsupported'
  readonly workspaceId?: string
  readonly message: string
}

/** Non-running delete failure after some sessions were already irreversibly deleted. */
export interface ArchivedWorkspaceDeletePartialError {
  readonly code: 'workspace-delete-partial'
  readonly workspaceId?: string
  readonly deletedCount: number
  readonly failedSessionId: string
  readonly message: string
}

export type ArchivedWorkspaceDeleteValue =
  | ArchivedWorkspaceDeleteResult
  | ArchivedWorkspaceRunningError
  | ArchivedWorkspaceDeleteUnsupportedError
  | ArchivedWorkspaceDeletePartialError
```

在 `src/index.ts` 顶部 import 中追加：

```ts
import type {
  ArchivedWorkspaceDeleteRequest,
  ArchivedWorkspaceDeleteValue,
} from './types.ts'
```

把 `list()` 拆出 `collectItems()`（保留原排序与 capabilities）：

```ts
  /** List all currently archived sessions with display metadata. */
  @Remote('list')
  async list(): Promise<ArchivedSessionListResult> {
    const items = await this.collectItems()
    items.sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    return { items, capabilities: this.capabilities() }
  }

  /** Build the unsorted archived-session rows shared by list and deleteWorkspace. */
  private async collectItems(): Promise<ArchivedSessionItem[]> {
    const ctx = this.ctx
    const ids = [...ctx.workspaceRegistry.archivedSessionIds]

    const snapshots = await ctx.sessionPersistence.listSnapshots()
    const headers = new Map<string, SessionHeader>(
      snapshots.map(snapshot => [snapshot.header.id, snapshot.header]),
    )
    const workspaces = ctx.workspaceRegistry.list()

    const items: ArchivedSessionItem[] = []
    for (const sessionId of ids) {
      const live = ctx.sessions.get(sessionId)
      const header = live?.header ?? headers.get(sessionId)
      if (header === undefined) continue
      const events = live?.events ?? []
      let resolvedEvents = events
      if (live === undefined) {
        try {
          const inspection = await ctx.sessionPersistence.readFrom(sessionId, 0)
          resolvedEvents = inspection.events
        } catch (error) {
          ctx.logger.warn(
            `archived-sessions: could not read "${sessionId}" for listing (serving header-only): ${String(error)}`,
          )
        }
      }
      const running = ctx.agents.get(sessionId)?.status === 'running'
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(sessionId))
      items.push(item(
        sessionId,
        header,
        resolvedEvents,
        running,
        workspace === undefined ? undefined : {
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
        },
      ))
    }
    return items
  }
```

把 `delete()` 重构为调用 `deleteOne()`，并新增 `deleteOne()` 与 `deleteWorkspace()`：

```ts
  /** Permanently delete one session and its durable history. */
  @Remote('delete')
  async delete(request: ArchivedSessionDeleteRequest): Promise<ArchivedSessionDeleteValue> {
    const ctx = this.ctx
    const sessionId = SessionId(request.sessionId)

    if (typeof ctx.sessionPersistence.delete !== 'function') {
      return {
        code: 'delete-unsupported',
        sessionId: request.sessionId,
        message: 'permanent delete is unavailable on this DSH runtime',
      }
    }

    const agent = ctx.agents.get(sessionId)
    if (agent?.status === 'running') {
      return this.runningError(request.sessionId)
    }

    await this.deleteOne(sessionId)
    return { deleted: true }
  }

  /** Shared single-session irreversible delete used by delete and deleteWorkspace. */
  private async deleteOne(sessionId: SessionId): Promise<void> {
    const ctx = this.ctx
    const agent = ctx.agents.get(sessionId)
    const liveSession = ctx.sessions.get(sessionId)
    if (liveSession !== undefined && agent === undefined) {
      throw new Error(
        `archived-sessions: cannot delete live session "${sessionId}" because no live agent handle is available to detach it`,
      )
    }

    if (agent !== undefined) {
      const agentLoop = ctx.get('agentLoop') as
        | { disposeAgent(id: SessionId): Promise<boolean> }
        | undefined
      if (agentLoop === undefined) {
        throw new Error(
          `archived-sessions: cannot delete live session "${sessionId}" because the agent loop is not available`,
        )
      }
      await agentLoop.disposeAgent(sessionId)
    }

    const deleteSession = ctx.sessionPersistence.delete
    if (deleteSession === undefined) {
      throw new Error('archived-sessions: sessionPersistence.delete disappeared between capability check and delete')
    }
    await deleteSession(sessionId)

    for (const workspace of ctx.workspaceRegistry.list()) {
      try {
        await workspace.detachSession(sessionId)
      } catch (error: unknown) {
        ctx.logger.warn(
          `archived-sessions: workspace "${workspace.id}" could not detach deleted session "${sessionId}": ${String(error)}`,
        )
      }
    }

    try {
      // Same archive-set primitive as restore (native or rc.6 path).
      await this.archiveAdapter.removeFromArchiveSet(sessionId)
    } catch (error: unknown) {
      ctx.logger.warn(
        `archived-sessions: deleted session "${sessionId}" could not be removed from the archive set: ${String(error)}`,
      )
    }
  }

  /** Permanently delete every archived session in one workspace group. */
  @Remote('deleteWorkspace')
  async deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<ArchivedWorkspaceDeleteValue> {
    const ctx = this.ctx
    const workspaceId = request.workspaceId

    if (typeof ctx.sessionPersistence.delete !== 'function') {
      return {
        code: 'workspace-delete-unsupported',
        workspaceId,
        message: 'permanent delete is unavailable on this DSH runtime',
      }
    }

    const items = (await this.collectItems()).filter(item =>
      workspaceId === undefined ? item.workspaceId === undefined : item.workspaceId === workspaceId,
    )
    const running = items.filter(item => item.running)
    if (running.length > 0) {
      return {
        code: 'workspace-sessions-running',
        workspaceId,
        runningSessionCount: running.length,
        message: `cannot delete workspace group: ${running.length} session(s) are running`,
      }
    }

    let deletedCount = 0
    for (const item of items) {
      try {
        await this.deleteOne(SessionId(item.sessionId))
        deletedCount++
      } catch (error: unknown) {
        ctx.logger.warn(
          `archived-sessions: deleteWorkspace stopped after ${deletedCount} deletion(s); failed on "${item.sessionId}": ${String(error)}`,
        )
        return {
          code: 'workspace-delete-partial',
          workspaceId,
          deletedCount,
          failedSessionId: item.sessionId,
          message: `deleted ${deletedCount} session(s) before failing on "${item.sessionId}": ${String(error)}`,
        }
      }
    }

    return { deleted: true, deletedCount }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-plugin-archived-sessions run test`
Expected: PASS（全部 service 测试，包括新增 5 条）。

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-archived-sessions/src/types.ts packages/dsh-plugin-archived-sessions/src/index.ts packages/dsh-plugin-archived-sessions/tests/service.test.ts
git commit -m "feat(archived-sessions): 新增 deleteWorkspace Host 批量删除端点"
```

---

### Task 2: Store `deleteWorkspace` + 客户端 Remote 接线

**Files:**
- Modify: `packages/dsh-plugin-archived-sessions/src/client/store.ts`
- Modify: `packages/dsh-plugin-archived-sessions/src/client/index.ts`
- Test: `packages/dsh-plugin-archived-sessions/tests/store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ArchivedWorkspaceDeleteRequest` / `ArchivedWorkspaceDeleteValue`。
- Produces:
  - `ArchivedSessionsStore.deleteWorkspace(workspaceId?: string): Promise<void>`
  - `ArchivedSessionsStore.removeByWorkspace(workspaceId: string | undefined): void`
  - `ArchivedSessionsRemote.deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<RemoteResult<ArchivedWorkspaceDeleteValue>>`

- [ ] **Step 1: 在 `tests/store.test.ts` 追加失败的测试**

把 `makeRemote` 的默认 remote 对象改为：

```ts
  const remote: ArchivedSessionsRemote & { listCalls: () => number } = {
    list: async () => ({ ok: true, value: listResult(0) }),
    restore: async () => ({ ok: true, value: { restored: true } }),
    delete: async () => ({ ok: true, value: { deleted: true } }),
    deleteWorkspace: async () => ({ ok: true, value: { deleted: true, deletedCount: 0 } }),
    ...overrides,
    listCalls: () => listCalls,
  }
```

在文件末尾追加：

```ts
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

test('deleteWorkspace surfaces running abort and keeps the list', async () => {
  const items = [makeWorkspaceItem('a', 'A-1', 1)]
  const store = new ArchivedSessionsStore(makeRemote({
    list: async () => ({ ok: true, value: { items, capabilities: CAPABILITIES } }),
    deleteWorkspace: async () => ({
      ok: true,
      value: { code: 'workspace-sessions-running', runningSessionCount: 1, message: 'session is running' },
    }),
  }))
  await store.refresh()
  await assert.rejects(() => store.deleteWorkspace('a'), /session is running/)
  assert.equal(store.getSnapshot().items.length, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-plugin-archived-sessions run test`
Expected: FAIL，报 `store.deleteWorkspace is not a function`。

- [ ] **Step 3: 实现 `store.ts`**

顶部 import 追加：

```ts
import type {
  ArchivedWorkspaceDeleteRequest,
  ArchivedWorkspaceDeleteValue,
} from '../types.ts'
```

`ArchivedSessionsRemote` 增加：

```ts
  deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<RemoteResult<ArchivedWorkspaceDeleteValue>>
```

在 `delete()` 之后新增：

```ts
  /**
   * Permanently delete every archived session in one workspace group, then
   * remove the whole group from the local list after the Host confirms.
   * `workspaceId` omitted targets ungrouped sessions (未知工作区).
   */
  async deleteWorkspace(workspaceId?: string): Promise<void> {
    const result = await this.remote.deleteWorkspace(workspaceId === undefined ? {} : { workspaceId })
    if (!result.ok) throw new Error(result.error.message)
    if ('deleted' in result.value) {
      this.removeByWorkspace(workspaceId)
      return
    }
    const error = new Error(result.value.message)
    Object.assign(error, { code: result.value.code })
    throw error
  }

  /** Drop every item that belongs to one workspace group. */
  removeByWorkspace(workspaceId: string | undefined): void {
    const items = workspaceId === undefined
      ? this.state.items.filter(item => item.workspaceId !== undefined)
      : this.state.items.filter(item => item.workspaceId !== workspaceId)
    if (items.length === this.state.items.length) return
    this.state = {
      ...this.state,
      items,
    }
    this.emit()
  }
```

- [ ] **Step 4: 实现 `client/index.ts` 接线**

import 追加：

```ts
import type {
  ArchivedWorkspaceDeleteRequest,
  ArchivedWorkspaceDeleteValue,
} from '../types.ts'
```

`MountedArchivedSessionsRemote` 增加：

```ts
    deleteWorkspace(request: ArchivedWorkspaceDeleteRequest): Promise<RemoteResult<ArchivedWorkspaceDeleteValue>>
```

`ArchivedSessionsStore` 构造参数增加：

```ts
      deleteWorkspace: request => mounted.archivedSessions.deleteWorkspace(request),
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter dsh-plugin-archived-sessions run test`
Expected: PASS（store 新增 3 条通过）。

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin-archived-sessions/src/client/store.ts packages/dsh-plugin-archived-sessions/src/client/index.ts packages/dsh-plugin-archived-sessions/tests/store.test.ts
git commit -m "feat(archived-sessions): Store 支持 deleteWorkspace 并整组移除本地行"
```

---

### Task 3: UI 组头删除入口 + 文案 + 静态测试

**Files:**
- Modify: `packages/dsh-plugin-archived-sessions/src/client/locales.ts`
- Modify: `packages/dsh-plugin-archived-sessions/src/client/ArchivedSessionsSection.tsx`
- Test: `packages/dsh-plugin-archived-sessions/tests/static.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `store.deleteWorkspace(workspaceId?: string)`。
- Produces: 组头“删除工作区”按钮、批量删除 RiskConfirmation、运行中/部分失败/unsupported 的用户文案。

- [ ] **Step 1: 在 `tests/static.test.ts` 追加失败的测试**

在文件末尾追加：

```ts
test('workspace delete is rendered at the group header and hidden during search', () => {
  assert.match(sectionSource, /deletingWorkspace/)
  assert.match(sectionSource, /t\('deleteWorkspace'\)/)
  assert.match(sectionSource, /!searching &&/)
  assert.match(sectionSource, /store\.deleteWorkspace\(/)
})

test('workspace delete uses RiskConfirmation and surfaces running/partial errors', () => {
  assert.match(sectionSource, /deleteWorkspaceTitle/)
  assert.match(sectionSource, /deleteWorkspaceRunning/)
  assert.match(sectionSource, /deleteWorkspacePartial/)
  assert.match(sectionSource, /deleteWorkspaceUnavailable/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-plugin-archived-sessions run test`
Expected: FAIL（新增两条静态断言不匹配）。

- [ ] **Step 3: 实现 `locales.ts`**

zh 追加：

```ts
  deleteWorkspace: '删除工作区',
  deletingWorkspace: '删除中…',
  deleteWorkspaceTitle: '删除工作区的归档会话',
  deleteWorkspaceDescription: '将永久删除该工作区下的全部归档会话，工作区本身会保留。此操作不可撤销。',
  deleteWorkspaceAcknowledge: '我了解该操作会永久删除这些会话及历史记录',
  deleteWorkspaceRunning: '有归档会话正在运行，已中止删除。请先处理运行中的会话',
  deleteWorkspacePartial: '部分会话删除失败，已删除',
  deleteWorkspaceUnavailable: '当前 DSH 运行时不支持永久删除',
  deleteWorkspaceFailed: '删除工作区归档会话失败',
```

en 追加：

```ts
  deleteWorkspace: 'Delete workspace',
  deletingWorkspace: 'Deleting…',
  deleteWorkspaceTitle: 'Delete workspace archived sessions',
  deleteWorkspaceDescription: 'This permanently deletes every archived session in this workspace. The workspace itself is kept. This action cannot be undone.',
  deleteWorkspaceAcknowledge: 'I understand this will permanently delete these sessions and their history',
  deleteWorkspaceRunning: 'Some archived sessions are running. Deletion aborted. Handle running sessions first',
  deleteWorkspacePartial: 'Some sessions failed to delete. Deleted',
  deleteWorkspaceUnavailable: 'Permanent delete is unavailable on this DSH runtime',
  deleteWorkspaceFailed: 'Failed to delete workspace archived sessions',
```

- [ ] **Step 4: 实现 `ArchivedSessionsSection.tsx`**

新增样式常量（放在 `groupCountStyle` 之后）：

```ts
const groupActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexShrink: 0,
}
```

组件内新增 state（放在 `deleting` state 附近）：

```ts
  const [deletingWorkspace, setDeletingWorkspace] = useState<ArchivedGroup | null>(null)
```

新增 handler（放在 `handleDelete` 之后）：

```ts
  const handleDeleteWorkspace = (): void => {
    if (deletingWorkspace === null) return
    const target = deletingWorkspace
    const workspaceKey = target.key === '__ungrouped__' ? undefined : target.key
    setDeletingWorkspace(null)
    setAcknowledged(false)
    setBusyId(`workspace:${target.key}`)
    setActionError(null)
    void (async () => {
      try {
        await store.deleteWorkspace(workspaceKey)
      } catch (error: unknown) {
        console.error('archived-sessions: archivedSessions/deleteWorkspace failed', error)
        const code = (error as { code?: string }).code
        if (code === 'workspace-sessions-running') {
          const count = (error as { runningSessionCount?: number }).runningSessionCount
          setActionError(`${t('deleteWorkspaceRunning')}${count !== undefined ? `（${count}）` : ''}`)
        } else if (code === 'workspace-delete-partial') {
          const partial = error as { deletedCount?: number; failedSessionId?: string }
          setActionError(`${t('deleteWorkspacePartial')}${partial.deletedCount !== undefined ? `（${partial.deletedCount}）` : ''}`)
        } else if (code === 'workspace-delete-unsupported') {
          setActionError(t('deleteWorkspaceUnavailable'))
        } else {
          setActionError(t('deleteWorkspaceFailed'))
        }
      } finally {
        setBusyId(null)
      }
    })()
  }
```

组头中把 `groupCountStyle` 的 `<span>` 替换为带按钮的容器：

```tsx
              <span style={groupActionsStyle}>
                <span style={groupCountStyle}>
                  {group.items.length} {t('sessionCount')}
                </span>
                {!searching && (
                  <Button
                    variant="ghost"
                    style={{ color: 'var(--dsw-alias-state-error-primary)' }}
                    disabled={busyId === `workspace:${group.key}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setDeleting(null)
                      setDeletingWorkspace(group)
                      setAcknowledged(false)
                    }}
                  >
                    {busyId === `workspace:${group.key}` ? t('deletingWorkspace') : t('deleteWorkspace')}
                  </Button>
                )}
              </span>
```

在现有单条删除的 `RiskConfirmation` 之后追加：

```tsx
      {deletingWorkspace !== null && (
        <RiskConfirmation
          open
          title={t('deleteWorkspaceTitle')}
          description={`${t('workspace')}: ${deletingWorkspace.title}\n${deletingWorkspace.items.length} ${t('sessionCount')} · ${t('deleteWorkspaceDescription')}`}
          acknowledgeLabel={t('deleteWorkspaceAcknowledge')}
          cancelLabel={t('cancel')}
          confirmLabel={t('confirmDelete')}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => { setDeletingWorkspace(null); setAcknowledged(false) }}
          onConfirm={() => { handleDeleteWorkspace() }}
        />
      )}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter dsh-plugin-archived-sessions run test`
Expected: PASS（新增 2 条静态断言通过，原有静态断言不回归）。

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin-archived-sessions/src/client/locales.ts packages/dsh-plugin-archived-sessions/src/client/ArchivedSessionsSection.tsx packages/dsh-plugin-archived-sessions/tests/static.test.ts
git commit -m "feat(archived-sessions): 归档会话页新增工作区批量删除入口与文案"
```

---

### Task 4: 更新 Typert 契约与完整构建验证

**Files:**
- Modify: `packages/dsh-plugin-archived-sessions/scripts/check-typert-contract.mjs`
- Modify: `packages/dsh-plugin-archived-sessions/tests/static.test.ts`

**Interfaces:**
- Consumes: Task 1 新增的 `deleteWorkspace` 端点；生成的 `lib/typert.host.js` / `lib/typert.remote-client.js`。
- Produces: 构建产物包含并验证 `archivedSessions/deleteWorkspace` strict 端点。

- [ ] **Step 1: 更新 `check-typert-contract.mjs`**

```js
const REQUIRED_ENDPOINTS = ['list', 'restore', 'delete', 'deleteWorkspace']
```

- [ ] **Step 2: 更新 `tests/static.test.ts`**

“built Host and Client Typert artifacts contain all strict endpoints” 测试中的方法数组改为：

```ts
    for (const method of ['list', 'restore', 'delete', 'deleteWorkspace']) {
```

“restore / capabilities wire types are present in the built declarations” 测试中追加：

```ts
  assert.match(dts, /interface ArchivedWorkspaceDeleteRequest/)
  assert.match(dts, /interface ArchivedWorkspaceDeleteResult/)
  assert.match(dts, /code: 'workspace-sessions-running'/)
  assert.match(dts, /code: 'workspace-delete-unsupported'/)
  assert.match(dts, /code: 'workspace-delete-partial'/)
```

- [ ] **Step 3: 完整构建**

Run: `pnpm --filter dsh-plugin-archived-sessions run build`
Expected: PASS，`Typert contract verified` 包含 4 个端点，产物重新生成。

- [ ] **Step 4: 完整测试**

Run: `pnpm --filter dsh-plugin-archived-sessions run test`
Expected: PASS（所有 service/store/static 测试）。

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-archived-sessions/scripts/check-typert-contract.mjs packages/dsh-plugin-archived-sessions/tests/static.test.ts
git commit -m "chore(archived-sessions): 将 deleteWorkspace 纳入 Typert 契约与静态断言"
```
