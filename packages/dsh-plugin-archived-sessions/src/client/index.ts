/**
 * Archived Sessions plugin Client half.
 *
 * Mounts the generated Host Remote contribution, registers the `归档会话`
 * Settings section, and keeps the section's store in sync with the workspace
 * archive set.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import remote from 'dsh-plugin-archived-sessions/remote'
import { ArchivedSessionsSection } from './ArchivedSessionsSection.tsx'
import { NS, zh, en } from './locales.ts'
import { ArchivedSessionsStore } from './store.ts'
import type { ArchivedSessionsKey } from './locales.ts'
import type {
  ArchivedSessionDeleteRequest,
  ArchivedSessionDeleteValue,
  ArchivedSessionListResult,
} from '../types.ts'

export { ArchivedSessionsStore } from './store.ts'
export { ArchivedSessionsSection } from './ArchivedSessionsSection.tsx'

/** Services required before the Remote contribution can be mounted. */
export const inject = ['slots', 'locale', 'sessions', 'workspaces', 'remote']

/**
 * The plugin's own Remote namespace as mounted by this fiber. The structural
 * face is declared locally so the client half does not depend on which DSH
 * `@deepseek-ai/dsh-typert-protocol` copy provides `TypertClientRemote`.
 */
interface MountedArchivedSessionsRemote {
  archivedSessions: {
    list(): Promise<RemoteResult<ArchivedSessionListResult>>
    delete(request: ArchivedSessionDeleteRequest): Promise<RemoteResult<ArchivedSessionDeleteValue>>
  }
}

/**
 * Settings-section child plugin.
 *
 * This package both mounts its own Remote namespace and consumes it, so the
 * consumer half cannot declare `remote.archivedSessions` at boot time (Cordis
 * would wait for a service this same fiber is about to create). The outer
 * plugin mounts the namespace first, then starts this child plugin; by then
 * `remote.archivedSessions` exists and can be injected normally.
 */
const ArchivedSessionsSectionPlugin = {
  inject: ['slots', 'locale', 'sessions', 'workspaces', 'remote', 'remote.archivedSessions'],
  apply(ctx: ClientContext): void {
    // Fail at startup instead of letting a user click Restore on an old DSH
    // build that lacks the upstream `unarchiveSession` / `workspace.restoreSession`
    // capability. The plugin's published minimum-version contract is documented
    // in README.md.
    if (typeof ctx.workspaces.restoreSession !== 'function') {
      throw new Error(
        'archived-sessions: incompatible DSH version — WorkspaceRegistry.unarchiveSession '
        + '/ workspace.restoreSession is unavailable. Upgrade DSH to the minimum version '
        + 'documented in the plugin README.',
      )
    }

    const mounted = ctx.remote as unknown as MountedArchivedSessionsRemote
    const store = new ArchivedSessionsStore(
      {
        list: () => mounted.archivedSessions.list(),
        delete: request => mounted.archivedSessions.delete(request),
      },
      sessionId => ctx.workspaces.restoreSession(sessionId as SessionId),
    )

    // Realtime sync: the workspace runtime already folds
    // `host/archived-sessions-changed` into its list snapshot, so a workspace
    // list change is the authoritative trigger to refresh our detail rows.
    ctx.effect(() => {
      return ctx.workspaces.list.subscribe(() => { void store.refresh() })
    }, 'archived-sessions: workspace archive sync')

    const t = ctx.locale.bind(NS)

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'archived-sessions',
      order: 25,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({
        store,
        t: t as (key: ArchivedSessionsKey) => string,
      }),
    }, ArchivedSessionsSection))
  },
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Locale dictionaries live for the fiber; re-registration is HMR-safe.
  ctx.effect(() => {
    const offZh = ctx.locale.register(NS, 'zh', zh)
    const offEn = ctx.locale.register(NS, 'en', en)
    return () => { offZh(); offEn() }
  }, 'archived-sessions: dictionaries')

  // Mount the Host Remote API.
  const mountPromise = ctx.remote.$mount(remote)
  ctx.effect(() => {
    let disposer: (() => Promise<void>) | undefined
    void mountPromise.then((value) => { disposer = value })
    return () => { void disposer?.() }
  }, 'archived-sessions: remote mount')

  // Start the Settings section only after the Remote namespace is mounted, so
  // the child can inject `remote.archivedSessions` without a boot deadlock.
  ctx.effect(() => {
    let disposed = false
    let child: { dispose(): void } | undefined
    void mountPromise.then(() => {
      if (disposed) return
      child = ctx.plugin(ArchivedSessionsSectionPlugin)
    })
    return () => {
      disposed = true
      child?.dispose()
    }
  }, 'archived-sessions: settings plugin')
}
