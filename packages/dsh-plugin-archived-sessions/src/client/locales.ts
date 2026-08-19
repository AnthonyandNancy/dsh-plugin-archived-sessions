/** Archived Sessions plugin locale dictionaries (zh is the key source). */

export const NS = 'archived-sessions'

export const zh = {
  nav: '归档会话',
  title: '归档会话',
  subtitle: '管理已归档的会话，可恢复或永久删除。',
  search: '搜索会话…',
  sortLastActivity: '最后活动',
  sortCreatedAt: '创建于',
  restore: '恢复',
  restoring: '恢复中…',
  delete: '永久删除',
  sessionCount: '个会话',
  loading: '加载中…',
  empty: '暂无归档会话',
  error: '加载失败',
  retry: '重试',
  running: '运行中',
  workspace: '工作区',
  lastActivity: '最后活动',
  createdAt: '创建于',
  confirmDelete: '永久删除',
  deleteTitle: '永久删除会话',
  deleteDescription: '此操作不可撤销。会话及其全部历史记录将被永久删除。',
  deleteAcknowledge: '我了解该操作会永久删除此会话及历史记录',
  cancel: '取消',
  deleteFailed: '删除失败',
  restoreFailed: '恢复失败',
  restoreUnavailable: '当前 DSH 运行时不支持恢复',
  deleteUnavailable: '当前 DSH 运行时不支持永久删除',
  unknownWorkspace: '未知工作区',
}

export const en = {
  nav: 'Archived Sessions',
  title: 'Archived Sessions',
  subtitle: 'Manage archived sessions. Restore them or delete them permanently.',
  search: 'Search sessions…',
  sortLastActivity: 'Last activity',
  sortCreatedAt: 'Created',
  restore: 'Restore',
  restoring: 'Restoring…',
  delete: 'Delete permanently',
  sessionCount: 'sessions',
  loading: 'Loading…',
  empty: 'No archived sessions',
  error: 'Failed to load',
  retry: 'Retry',
  running: 'Running',
  workspace: 'Workspace',
  lastActivity: 'Last activity',
  createdAt: 'Created',
  confirmDelete: 'Delete permanently',
  deleteTitle: 'Delete session permanently',
  deleteDescription: 'This action cannot be undone. The session and all of its history will be permanently deleted.',
  deleteAcknowledge: 'I understand this will permanently delete the session and its history',
  cancel: 'Cancel',
  deleteFailed: 'Delete failed',
  restoreFailed: 'Restore failed',
  restoreUnavailable: 'Restore is unavailable on this DSH runtime',
  deleteUnavailable: 'Permanent delete is unavailable on this DSH runtime',
  unknownWorkspace: 'Unknown workspace',
}

export type ArchivedSessionsKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'archived-sessions': ArchivedSessionsKey
  }
}
