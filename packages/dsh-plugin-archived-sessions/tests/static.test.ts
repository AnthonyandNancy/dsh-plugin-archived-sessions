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

test('restore / capabilities wire types are present in the built declarations', () => {
  const dts = readFileSync(join(SRC_ROOT, '..', 'lib', 'types', 'types.d.ts'), 'utf8')
  assert.match(dts, /interface ArchivedSessionRestoreRequest/)
  assert.match(dts, /interface ArchivedSessionRestoreResult/)
  assert.match(dts, /code: 'restore-unsupported'/)
  assert.match(dts, /interface ArchivedSessionDeleteUnsupportedError/)
  assert.match(dts, /interface ArchivedSessionsCapabilities/)
  assert.match(dts, /restore: 'native' \| 'rc6-compat' \| 'unsupported'/)
})

test('built Host and Client Typert artifacts contain all strict endpoints', () => {
  for (const relativePath of ['lib/typert.host.js', 'lib/typert.remote-client.js']) {
    const artifact = readFileSync(join(SRC_ROOT, '..', relativePath), 'utf8')
    for (const method of ['list', 'restore', 'delete']) {
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
