import type { ArchivedSessionItem } from '../types.ts'

export interface ArchivedGroup {
  readonly key: string
  readonly title: string
  readonly items: ArchivedSessionItem[]
}

/**
 * Groups a fully filtered / sorted item list by workspace.
 *
 * The function must always be called with the complete list (never a
 * session-reveal slice): workspace headers are first-class navigation and
 * must not disappear just because only the first N sessions are rendered.
 * The group order follows the first occurrence in `items`, which keeps the
 * current sort order stable.
 */
export function groupByWorkspace(items: readonly ArchivedSessionItem[], unknownWorkspace: string): ArchivedGroup[] {
  const groups: ArchivedGroup[] = []
  const index = new Map<string, number>()
  for (const item of items) {
    const key = item.workspaceId ?? '__ungrouped__'
    const title = item.workspaceTitle ?? unknownWorkspace
    const existing = index.get(key)
    if (existing === undefined) {
      index.set(key, groups.length)
      groups.push({ key, title, items: [item] })
    } else {
      groups[existing]?.items.push(item)
    }
  }
  return groups
}
