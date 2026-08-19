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

test('plugin code has 0 references to ctx.workspaces.restoreSession', () => {
  const hits = sources.filter(({ text }) => /restoreSession/.test(text))
  assert.deepEqual(hits.map(hit => hit.path), [])
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
