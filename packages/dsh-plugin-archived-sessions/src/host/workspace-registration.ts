/**
 * Host-side Workspace-registration removal.
 *
 * `WorkspaceRegistry.delete(id)` is the official first-party primitive — the
 * same call the official workspace controller makes for its own "Delete
 * workspace" action. Its documented semantics are deliberately
 * non-destructive: the registration and its place in the durable display
 * order go away, while the directory, the files and every session log are
 * retained and the sessions fall back to Ungrouped.
 *
 * The plugin routes the call through this small module for the same reason it
 * routes restore through the archive adapter: one capability-detected entry
 * point, no version-string comparison, and a runtime without the API degrades
 * to a domain result instead of failing plugin startup.
 *
 * Duplicate concern with the archive set: deleting a registration does NOT
 * touch `archivedSessionIds`, so a session archived under the removed
 * workspace keeps its archive entry and would otherwise reappear as an
 * "unknown workspace" row. Callers that intend to remove the group entirely
 * must clear the group's archived sessions as well.
 *
 * @module dsh-plugin-archived-sessions/host/workspace-registration
 */

/** How a Workspace registration can be removed on this runtime. */
export type WorkspaceDeleteCapability = 'native' | 'unsupported'

/**
 * Minimal registry surface used for registration removal. `delete` is
 * optional so the adapter probes the instance it is handed rather than
 * trusting a declared type.
 */
export interface WorkspaceRegistrationStorage {
  delete?(workspaceId: string): Promise<boolean>
}

/**
 * Capability-detecting remover over one runtime registry instance.
 *
 * `delete` is idempotent at the registry level: an unknown id resolves
 * `false` without writing, which this adapter reports as `not-found` so the
 * caller can answer a domain result instead of an exception.
 */
export class WorkspaceRegistrationDeleter {
  private readonly registry: WorkspaceRegistrationStorage
  private readonly capability: WorkspaceDeleteCapability

  constructor(registry: unknown) {
    const candidate = (registry ?? {}) as WorkspaceRegistrationStorage
    this.registry = candidate
    this.capability = typeof candidate.delete === 'function' ? 'native' : 'unsupported'
  }

  getDeleteCapability(): WorkspaceDeleteCapability {
    return this.capability
  }

  /**
   * Remove one registration without deleting its directory or session logs.
   *
   * @returns `true` when a record was deleted, `false` when the id was
   *   unknown (already removed — the requested end state).
   * @throws when the runtime exposes no such API, or when the registry write
   *   itself fails.
   */
  async remove(workspaceId: string): Promise<boolean> {
    const remove = this.registry.delete
    if (typeof remove !== 'function') {
      throw new Error('archived-sessions: this DSH runtime exposes no WorkspaceRegistry.delete')
    }
    return await remove.call(this.registry, workspaceId)
  }
}
