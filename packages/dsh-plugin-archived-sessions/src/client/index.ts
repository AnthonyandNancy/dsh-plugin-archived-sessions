/**
 * Archived Sessions plugin Client half.
 *
 * Mounts the generated Host Remote contribution, registers the `归档会话`
 * Settings section, and keeps the section's store in sync with the workspace
 * archive set.
 */

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
  ArchivedSessionRestoreRequest,
  ArchivedSessionRestoreValue,
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
    restore(request: ArchivedSessionRestoreRequest): Promise<RemoteResult<ArchivedSessionRestoreValue>>
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
    // Restore is purely a Host Remote concern: the Host capability-detects
    // the official registry API vs the rc.6 mutation surface and answers
    // `restore-unsupported` as a domain result. The client never reaches
    // into the workspace runtime's restore API, so no runtime shape can
    // block plugin startup.
    const mounted = ctx.remote as unknown as MountedArchivedSessionsRemote
    const store = new ArchivedSessionsStore({
      list: () => mounted.archivedSessions.list(),
      restore: request => mounted.archivedSessions.restore(request),
      delete: request => mounted.archivedSessions.delete(request),
    })

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

  // Mount the Host Remote API and create the Settings consumer from the same
  // owner. Keeping the mount, child plugin, and disposer in one effect avoids a
  // race where a fast reload disposes before $mount() resolves, leaving a late
  // contribution mounted without an owner.
  ctx.effect(() => {
    let disposed = false
    let remoteDisposer: (() => Promise<void>) | undefined
    let child: { dispose(): void } | undefined

    const mount = async (): Promise<void> => {
      try {
        const disposer = await ctx.remote.$mount(remote)
        if (disposed) {
          await disposer()
          return
        }
        remoteDisposer = disposer
        child = ctx.plugin(ArchivedSessionsSectionPlugin)
      } catch (error: unknown) {
        // Keep the original assembly error in the developer console. The UI
        // action mapping handles end-user errors separately and never exposes
        // Typert fallback/withdrawal internals in a settings row.
        console.error('archived-sessions: failed to mount Remote contribution', error)
      }
    }
    void mount()

    return () => {
      disposed = true
      child?.dispose()
      const disposer = remoteDisposer
      if (disposer !== undefined) void disposer().catch(error => {
        console.error('archived-sessions: failed to dispose Remote contribution', error)
      })
    }
  }, 'archived-sessions: remote and settings lifecycle')
}
