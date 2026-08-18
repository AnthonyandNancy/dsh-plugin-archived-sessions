/**
 * Archived Sessions Settings section.
 *
 * Renders the archive manager inside the DSH Settings page: search, sort,
 * workspace grouping, append-only infinite scroll, restore, and a
 * checkbox-gated permanent delete confirmation. Restore is pessimistic and
 * removes only the restored row after the Host confirms.
 */

import { useSyncExternalStore, useState, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { Button, Input, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchivedSessionItem } from '../types.ts'
import type { ArchivedSessionsStore } from './store.ts'
import type { ArchivedSessionsKey } from './locales.ts'

export interface ArchivedSessionsSectionProps {
  /** Close the Settings panel (owned by the shell). Kept because the shell supplies it to every section. */
  close: () => void
  /** Store created by the client entry. */
  store: ArchivedSessionsStore
  /** Locale-bound translator for this plugin's namespace. */
  t: (key: ArchivedSessionsKey) => string
}

interface ArchivedGroup {
  readonly key: string
  readonly title: string
  readonly items: ArchivedSessionItem[]
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '12px 0',
  borderBottom: '1px solid var(--dsw-alias-divider)',
}

const rowMainStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '14px',
  fontWeight: 600,
  color: 'var(--dsw-alias-text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const metaStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: '12px',
  color: 'var(--dsw-alias-text-secondary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const toolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginBottom: '12px',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexShrink: 0,
}

const stateStyle: CSSProperties = {
  padding: '24px 0',
  textAlign: 'center',
  color: 'var(--dsw-alias-text-secondary)',
  fontSize: '14px',
}

const groupHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 0 6px',
  borderBottom: '1px solid var(--dsw-alias-divider)',
}

const groupTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--dsw-alias-text-primary)',
}

const groupCountStyle: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  color: 'var(--dsw-alias-text-secondary)',
}

export function ArchivedSessionsSection({
  close: _close,
  store,
  t,
}: ArchivedSessionsSectionProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [deleting, setDeleting] = useState<ArchivedSessionItem | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void store.refresh()
  }, [store])

  const items = useMemo(() => {
    const query = state.filter.trim().toLowerCase()
    const filtered = query.length === 0
      ? [...state.items]
      : state.items.filter(item =>
        item.title.toLowerCase().includes(query)
        || item.sessionId.toLowerCase().includes(query)
        || (item.workspaceTitle ?? '').toLowerCase().includes(query))
    return filtered.sort((left, right) =>
      state.sort === 'lastActivity'
        ? right.lastActivityAt - left.lastActivityAt
        : right.createdAt - left.createdAt)
  }, [state.items, state.filter, state.sort])

  const visibleItems = useMemo(() => items.slice(0, state.loadedCount), [items, state.loadedCount])
  const hasMore = state.loadedCount < items.length

  const groups = useMemo(() => groupByWorkspace(visibleItems, t('unknownWorkspace')), [visibleItems, t])
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      const key = item.workspaceId ?? '__ungrouped__'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [items])

  useEffect(() => {
    if (!hasMore) return
    const node = sentinelRef.current
    if (node === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) store.loadMore()
    }, { rootMargin: '200px' })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [store, hasMore])

  const runAction = async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusyId(id)
    setActionError(null)
    try {
      await action()
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  const handleRestore = (item: ArchivedSessionItem): void => {
    void runAction(item.sessionId, () => store.restore(item.sessionId))
  }

  const handleDelete = (): void => {
    if (deleting === null) return
    const target = deleting
    setDeleting(null)
    setAcknowledged(false)
    void runAction(target.sessionId, () => store.delete(target.sessionId))
  }

  return (
    <div style={{ padding: '0 2px' }}>
      <p style={{ margin: '0 0 16px', color: 'var(--dsw-alias-text-secondary)', fontSize: '13px' }}>
        {t('subtitle')}
      </p>

      <div style={toolbarStyle}>
        <div style={{ flex: 1 }}>
          <Input
            placeholder={t('search')}
            value={state.filter}
            onChange={(event) => { store.setFilter(event.currentTarget.value) }}
            style={{ width: '100%' }}
          />
        </div>
        <Button
          variant="outline"
          onClick={() => { store.setSort(state.sort === 'lastActivity' ? 'createdAt' : 'lastActivity') }}
        >
          {state.sort === 'lastActivity' ? t('sortLastActivity') : t('sortCreatedAt')}
        </Button>
      </div>

      {actionError !== null && (
        <p style={{ margin: '0 0 8px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' }}>
          {actionError}
        </p>
      )}

      {state.status === 'loading' && items.length === 0 && (
        <div style={stateStyle}>{t('loading')}</div>
      )}
      {state.status === 'error' && items.length === 0 && (
        <div style={stateStyle}>
          <p style={{ margin: '0 0 8px' }}>{t('error')}</p>
          <Button variant="outline" onClick={() => { void store.refresh() }}>{t('retry')}</Button>
        </div>
      )}
      {state.status === 'ready' && items.length === 0 && (
        <div style={stateStyle}>{t('empty')}</div>
      )}

      {items.length > 0 && groups.map(group => (
        <div key={group.key}>
          <div style={groupHeaderStyle}>
            <h3 style={groupTitleStyle}>{group.title}</h3>
            <span style={groupCountStyle}>
              {groupCounts.get(group.key) ?? group.items.length} {t('sessionCount')}
            </span>
          </div>
          {group.items.map(item => (
            <div key={item.sessionId} style={rowStyle}>
              <div style={rowMainStyle}>
                <p style={titleStyle}>{item.title}</p>
                <p style={metaStyle}>
                  {item.workspaceTitle ?? t('unknownWorkspace')}
                  {item.running ? ` · ${t('running')}` : ''}
                  {' · '}
                  {state.sort === 'lastActivity' ? t('lastActivity') : t('createdAt')}
                  {' '}
                  {formatTime(state.sort === 'lastActivity' ? item.lastActivityAt : item.createdAt)}
                </p>
              </div>
              <div style={actionsStyle}>
                <Button
                  variant="outline"
                  disabled={busyId === item.sessionId}
                  onClick={() => { handleRestore(item) }}
                >
                  {busyId === item.sessionId ? t('restoring') : t('restore')}
                </Button>
                <Button
                  variant="ghost"
                  style={{ color: 'var(--dsw-alias-state-error-primary)' }}
                  disabled={busyId === item.sessionId || item.running}
                  onClick={() => {
                    setDeleting(item)
                    setAcknowledged(false)
                  }}
                >
                  {t('delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ))}

      {hasMore && <div ref={sentinelRef} style={{ height: 1 }} />}

      {deleting !== null && (
        <RiskConfirmation
          open
          title={t('deleteTitle')}
          description={`${deleting.title}\n${t('workspace')}: ${deleting.workspaceTitle ?? t('unknownWorkspace')}\n${t('deleteDescription')}`}
          acknowledgeLabel={t('deleteAcknowledge')}
          cancelLabel={t('cancel')}
          confirmLabel={t('confirmDelete')}
          acknowledged={acknowledged}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => { setDeleting(null); setAcknowledged(false) }}
          onConfirm={() => { handleDelete() }}
        />
      )}
    </div>
  )
}

function groupByWorkspace(items: readonly ArchivedSessionItem[], unknownWorkspace: string): ArchivedGroup[] {
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

function formatTime(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
