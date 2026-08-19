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
  padding: '10px 0',
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

const groupContainerStyle: CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-divider)',
}

const groupHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  border: 0,
  background: 'transparent',
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
  padding: '12px 4px',
}

const groupContentStyle: CSSProperties = {
  paddingLeft: '24px',
  paddingTop: '4px',
  paddingBottom: '6px',
}

const groupHeadingStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  gap: '8px',
}

const groupTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '16px',
  lineHeight: '24px',
  fontWeight: 600,
  color: 'var(--dsw-alias-text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
  const loadingGuard = useRef(false)

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())

  const toggleGroup = (key: string): void => {
    // Do not modify expanded state during search — search temporarily overrides
    // all groups to expanded without touching the user's manual state.
    if (state.filter.trim().length > 0) return
    setExpandedGroups(previous => {
      const next = new Set(previous)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

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
      if (!entries.some(entry => entry.isIntersecting)) return
      // If all groups are collapsed, skip loading more — the sentinel would
      // stay visible and trigger an infinite loop.
      if (state.filter.trim().length === 0 && expandedGroups.size === 0) return
      if (loadingGuard.current) return
      loadingGuard.current = true
      store.loadMore()
      setTimeout(() => { loadingGuard.current = false }, 300)
    }, { rootMargin: '200px' })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [store, hasMore, state.filter, expandedGroups])

  const runAction = async (
    id: string,
    endpoint: 'restore' | 'delete',
    action: () => Promise<void>,
  ): Promise<void> => {
    setBusyId(id)
    setActionError(null)
    try {
      await action()
    } catch (error: unknown) {
      // Keep the transport/contract failure available to developers without
      // exposing Typert internals such as SRC fallback policy to end users.
      console.error(`archived-sessions: archivedSessions/${endpoint} failed`, error)
      setActionError(t(endpoint === 'restore' ? 'restoreFailed' : 'deleteFailed'))
    } finally {
      setBusyId(null)
    }
  }

  const handleRestore = (item: ArchivedSessionItem): void => {
    void runAction(item.sessionId, 'restore', () => store.restore(item.sessionId))
  }

  const handleDelete = (): void => {
    if (deleting === null) return
    const target = deleting
    setDeleting(null)
    setAcknowledged(false)
    void runAction(target.sessionId, 'delete', () => store.delete(target.sessionId))
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

      {items.length > 0 && groups.map(group => {
        const searching = state.filter.trim().length > 0
        const expanded = searching ? true : expandedGroups.has(group.key)

        return (
          <section key={group.key} style={groupContainerStyle}>
            <button
              type="button"
              aria-expanded={expanded}
              style={groupHeaderStyle}
              onClick={() => { toggleGroup(group.key) }}
            >
              <span style={groupHeadingStyle}>
                <Chevron expanded={expanded} />
                <span style={groupTitleStyle}>{group.title}</span>
              </span>
              <span style={groupCountStyle}>
                {groupCounts.get(group.key) ?? group.items.length} {t('sessionCount')}
              </span>
            </button>
            {expanded && (
              <div style={groupContentStyle}>
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
            )}
          </section>
        )
      })}

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

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      style={{
        transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 120ms ease',
        flexShrink: 0,
      }}
    >
      <path
        d="M5 6L8 9L11 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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
