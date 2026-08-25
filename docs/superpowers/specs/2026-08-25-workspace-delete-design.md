# 工作区批量删除归档会话 — 设计文档

日期：2026-08-25
状态：已确认（用户批准推荐方案 B）

## 背景与目标

在“设置 → 归档会话”管理页中，当前只能逐条永久删除归档会话；每个工作区组没有批量删除入口。
本功能为每个工作区组（以及“未知工作区”组）新增“删除工作区”操作：**永久删除该工作区下的全部归档会话，但保留工作区注册**。

## “未知工作区”成因（已查明）

DSH 会话页的“删除工作区”调用 `WorkspaceRegistry.delete(id)`，其语义为：

- 只删除工作区登记，保留目录与全部会话日志；
- 全局 `archivedSessionIds` 不受影响。

因此，已归档会话在其工作区被删除后仍留在归档集合中，但没有 workspace 记录可映射，
本插件将其归入“未知工作区”。这是 DSH 原生行为，不是插件 bug。
本插件通过为“未知工作区”提供批量删除入口来清理这类遗留归档会话。

## 方案选型

采用方案 B：新增 Host Remote `deleteWorkspace`，服务端统一完成运行中检查与批量删除，客户端单次 RPC。

- 不采用客户端循环调 `delete`（N 次 RPC、失败/中断不可控）。
- 不采用通用 `deleteMany(sessionIds)`（当前需求不需要，YAGNI）。

## 交互设计

- 每个工作区组标题右侧、会话数旁新增“删除工作区”按钮。
- 点击后弹出 RiskConfirmation 确认框：
  - 标题：删除工作区的归档会话；
  - 描述：工作区名、会话数量、不可撤销提示；
  - 需勾选确认。
- 删除成功后该组从列表消失；工作区注册与未归档会话不受影响。
- “未知工作区”组同样提供该按钮。
- **搜索状态下隐藏/禁用该按钮**：搜索时组内只显示过滤子集，防止误删过滤结果而非整组。

## Host 端设计

### types.ts 新增

```ts
export interface ArchivedWorkspaceDeleteRequest {
  /** 缺省表示“未知工作区 / 未分组” */
  readonly workspaceId?: string
}

export interface ArchivedWorkspaceDeleteResult {
  readonly deleted: true
  readonly deletedCount: number
}

export interface ArchivedWorkspaceRunningError {
  readonly code: 'workspace-sessions-running'
  readonly workspaceId?: string
  readonly runningSessionCount: number
  readonly message: string
}

export type ArchivedWorkspaceDeleteValue =
  | ArchivedWorkspaceDeleteResult
  | ArchivedWorkspaceRunningError
```

### index.ts 新增 `@Remote('deleteWorkspace')`

1. 按现有 `list` 逻辑获取当前归档会话，并按 `workspaceId`（或缺省 = 无 workspaceId）过滤；
2. 若存在任何 `running` 会话 → 返回 `workspace-sessions-running`，**一个都不删**；
3. 否则逐条复用现有删除逻辑：把当前 `delete` 的核心抽成私有 `deleteOne(sessionId)`，
   单条删除与批量删除共用同一套（dispose agent → persistence.delete → detachSession → 移出归档集合）；
4. 遇到非预期错误则中止并返回失败（含已删除数量），如实告知部分删除结果；
5. 全部成功返回 `{ deleted: true, deletedCount }`。

现有单条 `delete` 行为保持不变。

## 客户端设计

### store.ts

- `ArchivedSessionsRemote` 增加 `deleteWorkspace(request)`；
- 新增 `deleteWorkspace(workspaceKey)`：调用远程成功后，将本地列表中该组的全部 items 移除；
  失败抛错。

### ArchivedSessionsSection.tsx

- 组头新增“删除工作区”按钮；
- 新增批量删除确认状态与 RiskConfirmation；
- 展示批量删除错误（运行中中止、部分失败等）；
- 搜索时禁用/隐藏按钮。

### locales.ts

zh/en 新增：

- 删除工作区按钮；
- 批量删除确认标题/描述/确认勾选；
- 运行中中止提示；
- 部分失败提示。

## 测试

- `service.test.ts`：
  - `deleteWorkspace` 成功删除全部匹配会话；
  - 存在 running 会话时整组中止、一个不删；
  - 未知工作区（无 workspaceId）过滤与删除；
  - 中途失败返回已删除数量。
- `store.test.ts`：批量删除成功后本地组整体移除。
- 现有单条删除测试保持通过。

## 非目标

- 不删除工作区注册（用户已确认：仅删归档会话，保留工作区）。
- 不删除磁盘目录/未归档会话。
- 不改 DSH 会话页的“删除工作区”行为。
