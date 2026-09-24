/**
 * Static source guards for the compatibility contract: the plugin must never
 * reference `ctx.workspaces.restoreSession`, must not hard-fail startup on a
 * missing `WorkspaceRegistry.unarchiveSession`, must not write storage files
 * directly, must not inject runtime prototypes, and must not detect
 * capabilities by version string.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url))

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectSources(path, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

const sources = collectSources(SRC_ROOT).map(path => ({ path, text: readFileSync(path, 'utf8') }))
const sectionSource = readFileSync(join(SRC_ROOT, 'client', 'ArchivedSessionsSection.tsx'), 'utf8')
const clientIndexSource = readFileSync(join(SRC_ROOT, 'client', 'index.ts'), 'utf8')

test('plugin code has 0 references to ctx.workspaces.restoreSession', () => {
  const hits = sources.filter(({ text }) => /restoreSession/.test(text))
  assert.deepEqual(hits.map(hit => hit.path), [])
})

test('workspace groups provide a nested session content layout', () => {
  assert.match(sectionSource, /const groupContentStyle: CSSProperties = \{[\s\S]*paddingLeft: '24px'/)
  assert.match(sectionSource, /paddingTop: '4px'/)
  assert.match(sectionSource, /paddingBottom: '6px'/)
  assert.match(sectionSource, /padding: '12px 4px'/)
  assert.match(sectionSource, /<div style=\{groupContentStyle\}>/)
})

test('regression: all workspace headers derive from full items before session reveal', () => {
  assert.match(sectionSource, /const groups = useMemo\(\(\) => groupByWorkspace\(items, t\('unknownWorkspace'\)\)/)
  assert.doesNotMatch(sectionSource, /groupByWorkspace\(visibleItems/)
  assert.doesNotMatch(sectionSource, /visibleItems\s*=\s*items\.slice/)
  assert.doesNotMatch(sectionSource, /state\.loadedCount/)
  assert.doesNotMatch(sectionSource, /store\.loadMore\(\)/)
})

test('action failures use a user-facing message while logging the endpoint', () => {
  assert.match(sectionSource, /console\.error\(`archived-sessions: archivedSessions\/\$\{endpoint\} failed`, error\)/)
  assert.match(sectionSource, /setActionError\(t\(endpoint === 'restore' \? 'restoreFailed' : 'deleteFailed'\)\)/)
  assert.doesNotMatch(sectionSource, /setActionError\(error instanceof Error \? error\.message/)
})

test('Remote contribution has one client lifecycle owner', () => {
  assert.equal([...clientIndexSource.matchAll(/\$mount\(remote\)/g)].length, 1)
  assert.match(clientIndexSource, /const disposer = await ctx\.remote\.\$mount\(remote\)/)
  assert.match(clientIndexSource, /if \(disposed\) \{[\s\S]*await disposer\(\)/)
  assert.match(clientIndexSource, /const disposer = remoteDisposer[\s\S]*void disposer\(\)\.catch/)
})

test('no startup hard-fail on missing unarchiveSession / restoreSession', () => {
  const hits = sources.filter(({ text }) => /incompatible DSH version/.test(text))
  assert.deepEqual(hits.map(hit => hit.path), [])
})

test('unarchiveSession is only invoked through the compatibility adapter', () => {
  for (const { path, text } of sources) {
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (/unarchiveSession\(/.test(line) && !/compat[\\/]restore\.ts$/.test(path)) {
        assert.fail(`${path}:${index + 1}: unarchiveSession must only be called through the compatibility adapter`)
      }
    })
  }
})

test('no prototype injection into the DSH runtime', () => {
  for (const { path, text } of sources) {
    if (/prototype\s*[.=]|Object\.defineProperty/.test(text)) {
      assert.fail(`${path}: runtime prototype injection is prohibited`)
    }
  }
})

/**
 * DSH has no session-deletion API in any released version, so permanent delete
 * means the Host removes the durable log itself. That makes these two guards
 * path-scoped rather than absolute: the registry's registration-removal
 * primitive and the filesystem delete primitives may exist ONLY inside the two
 * modules that own them, and nowhere else in the plugin.
 */
const REGISTRATION_DELETE_OWNER = join('host', 'workspace-registration.ts')
const FILESYSTEM_DELETE_OWNER = join('host', 'session-log.ts')

test('Workspace-registry removal is only reachable through the registration-removal module', () => {
  // The audit covers every hand-written source in the workspace, not just this
  // package: a second, unaudited removal path could just as easily appear in a
  // sibling package.
  const workspaceRoot = join(SRC_ROOT, '..', '..', '..')
  const packageSources = [
    ...sources,
    ...collectSources(join(workspaceRoot, 'packages', 'dsh-typert-protocol', 'src'))
      .map(path => ({ path, text: readFileSync(path, 'utf8') })),
  ]

  // Any `.delete(...)` aimed at a registry object outside the owner module
  // would be a bypass. Documentation mentions are not removals, so only real
  // call sites count.
  const callSites = packageSources.filter(({ text }) =>
    /\b\w*[Rr]egistry\s*\.\s*delete\s*\(/.test(text.replace(/\/\*\*[\s\S]*?\*\//gu, '')))
  assert.deepEqual(
    callSites.map(hit => hit.path.slice(SRC_ROOT.length)),
    [],
  )

  // And nothing outside the owner may reach the runtime registry's delete.
  const runtimeReach = packageSources.filter(({ text }) =>
    /workspaceRegistry\s*\.\s*delete\s*\(/.test(text))
  assert.deepEqual(runtimeReach.map(hit => hit.path.slice(SRC_ROOT.length)), [])

  // The single install route is the owner's own delegation, and the owner must
  // actually call the runtime primitive — the guard cannot be satisfied by a
  // module that removes nothing. The call is made through the extracted method
  // (`remove.call(this.registry, …)`) so `this` stays the registry itself.
  const owner = sources.find(({ path }) => path.endsWith(REGISTRATION_DELETE_OWNER))
  assert.notEqual(owner, undefined, `${REGISTRATION_DELETE_OWNER} must exist`)
  assert.equal([...owner!.text.matchAll(/=\s*this\.registry\.delete\b/gu)].length, 1)
  assert.equal([...owner!.text.matchAll(/\.call\(this\.registry,/gu)].length, 1)
  const otherRemovers = sources.filter(({ path, text }) =>
    !path.endsWith(REGISTRATION_DELETE_OWNER) && /this\.registry\.delete\b/u.test(text))
  assert.deepEqual(otherRemovers.map(hit => hit.path), [])
})

test('filesystem delete primitives exist only in the session-log module', () => {
  const hits = sources.filter(({ text }) =>
    /\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/.test(text)
    || /node:fs/.test(text) && /\brm\b/.test(text))
  assert.deepEqual(
    hits.map(hit => hit.path.slice(SRC_ROOT.length)),
    [FILESYSTEM_DELETE_OWNER],
  )
})

test('the session-log module only removes session-owned artifacts', () => {
  const owner = sources.find(({ path }) => path.endsWith(FILESYSTEM_DELETE_OWNER))
  assert.notEqual(owner, undefined, `${FILESYSTEM_DELETE_OWNER} must exist`)
  const text = owner!.text
  // The allowlist must stay a filename allowlist: canonical log generations
  // (`session.jsonl`, `session.vN.jsonl`, with or without the zstd suffix),
  // the POSIX lock residue, and temp leftovers.
  assert.match(text, /session\(\?:\\\.v\[1-9\]\[0-9\]\*\)\?\\\.jsonl/)
  assert.match(text, /session\.lock/)
  assert.match(text, /\\\.tmp/)
  // Root containment is what stops a hostile or malformed header from aiming
  // the delete outside the session storage root.
  assert.match(text, /startsWith\(this\.root\)/)
  assert.match(text, /SessionLogPathRefusedError/)
})

test('no direct storage writes (fs write calls) in plugin code', () => {
  for (const { path, text } of sources) {
    if (/fs\.(writeFile|writeFileSync|appendFile|createWriteStream)|\bwriteFileSync\b/.test(text)) {
      assert.fail(`${path}: direct storage writes are prohibited`)
    }
  }
})

test('no single boolean `compatible` gate controlling the plugin', () => {
  for (const { path, text } of sources) {
    if (/compatible\s*:\s*boolean/.test(text)) {
      assert.fail(`${path}: use per-capability detection, not a global compatibility flag`)
    }
  }
})

test('no version-string capability detection', () => {
  for (const { path, text } of sources) {
    if (/['"]0\.1\.0-rc\.\d+['"]/.test(text)) {
      assert.fail(`${path}: capability detection must not compare version strings`)
    }
  }
})

test('restore / capabilities / workspace-delete wire types are present in the built declarations', () => {
  const dts = readFileSync(join(SRC_ROOT, '..', 'lib', 'types', 'types.d.ts'), 'utf8')
  assert.match(dts, /interface ArchivedSessionRestoreRequest/)
  assert.match(dts, /interface ArchivedSessionRestoreResult/)
  assert.match(dts, /code: 'restore-unsupported'/)
  assert.match(dts, /interface ArchivedSessionDeleteUnsupportedError/)
  assert.match(dts, /interface ArchivedSessionsCapabilities/)
  assert.match(dts, /restore: 'native' \| 'rc6-compat' \| 'unsupported'/)
  assert.match(dts, /interface ArchivedWorkspaceDeleteRequest/)
  assert.match(dts, /interface ArchivedWorkspaceDeleteResult/)
  assert.match(dts, /code: 'workspace-sessions-running'/)
  assert.match(dts, /code: 'workspace-delete-unsupported'/)
  assert.match(dts, /code: 'workspace-delete-partial'/)
  // Registration removal is a separate wire contract from group session deletion.
  assert.match(dts, /interface ArchivedWorkspaceRegistrationDeleteRequest/)
  assert.match(dts, /interface ArchivedWorkspaceRegistrationDeleteResult/)
  assert.match(dts, /code: 'workspace-not-found'/)
  assert.match(dts, /code: 'workspace-registration-delete-unsupported'/)
  assert.match(dts, /workspaceDelete: 'native' \| 'unsupported'/)
})

test('built Host and Client Typert artifacts contain all strict endpoints', () => {
  for (const relativePath of ['lib/typert.host.js', 'lib/typert.remote-client.js']) {
    const artifact = readFileSync(join(SRC_ROOT, '..', relativePath), 'utf8')
    for (const method of ['list', 'restore', 'delete', 'deleteWorkspace', 'deleteWorkspaceRegistration']) {
      const endpoint = `archivedSessions/${method}`
      const start = artifact.indexOf(endpoint)
      assert.notEqual(start, -1, `${relativePath} is missing ${endpoint}`)
      assert.match(artifact.slice(start, start + 1600), /mode: 'strict'/, `${relativePath} ${endpoint} is not strict`)
    }
  }
})

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

test('session row delete uses RiskConfirmation and is disabled while running', () => {
  assert.match(sectionSource, /setDeleting\(item\)/)
  assert.match(sectionSource, /disabled=\{\s*busyId === item\.sessionId\s*\|\|\s*item\.running/)
  assert.match(sectionSource, /store\.delete\(target\.sessionId\)/)
})

test('unknown workspace header keeps the workspace delete entry', () => {
  assert.match(sectionSource, /target\.key === '__ungrouped__' \? undefined : target\.key/)
  assert.doesNotMatch(sectionSource, /if \(!workspaceId\) return null/)
  assert.match(sectionSource, /store\.deleteWorkspace\(workspaceKey\)/)
})

test('delete actions are gated on their own host capability, not on a shared flag', () => {
  // Session/group log removal and Workspace-registration removal are separate
  // capabilities: a runtime can support one without the other, so a single
  // shared gate would be wrong in both directions.
  assert.match(sectionSource, /state\.capabilities\.delete !== 'native'/)
  assert.match(sectionSource, /state\.capabilities\.workspaceDelete !== 'native'/)
  assert.match(sectionSource, /store\.deleteWorkspaceRegistration\(/)
  assert.match(sectionSource, /removeWorkspaceRegistrationTitle/)
})

test('removing a registration never claims to have deleted sessions', () => {
  const registrationCopy = readFileSync(join(SRC_ROOT, 'client', 'locales.ts'), 'utf8')
  // The confirmation must state that the folder and session logs survive; the
  // action is the official registration-only removal.
  assert.match(registrationCopy, /removeWorkspaceRegistrationDescription/)
  assert.match(registrationCopy, /folder, its files and every session log are kept/)
  // And the group action's label must no longer promise workspace deletion.
  assert.match(registrationCopy, /deleteWorkspace: 'Clear archived sessions'/)
})
