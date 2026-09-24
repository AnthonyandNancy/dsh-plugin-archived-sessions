#!/usr/bin/env node
/**
 * Regenerate the source-plane shims (`src/index.ts`, `src/types.ts`) from the
 * vendored published declarations in `lib/`.
 *
 * The shims exist because the Typert generator works in two planes at once, and
 * the protocol has to exist in both:
 *
 * - **Discovery** (`WorkspaceAnalyzer.discoverPackages`) walks the *text* import
 *   graph from the manifest export targets mapped back to source, so the files
 *   named by the manifest must exist on disk inside the package.
 * - **Analysis** resolves every exported symbol back to a *source* file
 *   (`sourcePathForExport`: `lib/types/<x>.d.ts` → `src/<x>.ts`) that must be part
 *   of the TypeScript program, and holds every cross-package reference to the
 *   package that owns it.
 *
 * One name is deliberately left out of these lists: `TypertRegistryContract`. The
 * `Context.typert` member that the vendored `lib/types/types.d.ts` augments onto
 * Cordis is installed by the launcher, not by a plugin — exporting it here would
 * make the generator read this package as the provider of a `typert` service and
 * demand a `./typert` artifact from a package that publishes only the protocol.
 * See VENDOR.md.
 *
 * Usage:
 *   node scripts/sync-shims.mjs           # write the shims
 *   node scripts/sync-shims.mjs --check   # fail if they are out of date
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Names intentionally absent from the source plane; see the header comment. */
const OMITTED = new Set(['TypertRegistryContract'])

const SHIMS = [
  {
    declaration: 'lib/types/index.d.ts',
    shim: 'src/index.ts',
    specifier: '../lib/types/index.js',
    title: 'entry',
    counterpart: '`lib/index.js` and `lib/types/index.d.ts`',
  },
  {
    declaration: 'lib/types/types.d.ts',
    shim: 'src/types.ts',
    specifier: '../lib/types/types.js',
    title: '`./types` subpath',
    counterpart: '`lib/types/types.js` and `lib/types/types.d.ts`',
  },
]

/** Statements this script understands. Anything else is a hard error. */
const RULES = [
  {
    // `export { A, B } from './x.ts';`
    pattern: /^export\s+\{([^}]*)\}\s+from\s+['"][^'"]+['"];?$/,
    kind: 'value',
  },
  {
    // `export type { A, B } from './x.ts';`
    pattern: /^export\s+type\s+\{([^}]*)\}\s+from\s+['"][^'"]+['"];?$/,
    kind: 'type',
  },
  { pattern: /^export\s+declare\s+(?:abstract\s+)?class\s+(\w+)/, kind: 'value' },
  { pattern: /^export\s+declare\s+(?:const|let|var|enum)\s+(\w+)/, kind: 'value' },
  { pattern: /^export\s+declare\s+function\s+(\w+)/, kind: 'value' },
  { pattern: /^export\s+interface\s+(\w+)/, kind: 'type' },
  { pattern: /^export\s+type\s+(\w+)\s*[=<]/, kind: 'type' },
  // `export {};` — the marker that makes a declaration file a module.
  { pattern: /^export\s+\{\s*\};?$/, kind: 'skip' },
]

/**
 * Read every exported name out of one generated declaration file.
 * @param file - declaration file path relative to the package root.
 * @returns value and type export names, sorted.
 */
function collectExports(file) {
  const text = readFileSync(resolve(packageRoot, file), 'utf8')
  const values = new Set()
  const types = new Set()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('export')) continue
    const rule = RULES.find(candidate => candidate.pattern.test(trimmed))
    if (rule === undefined) {
      throw new Error(
        `${file}: unsupported export statement, extend RULES in this script:\n  ${trimmed}`,
      )
    }
    if (rule.kind === 'skip') continue
    const match = rule.pattern.exec(trimmed)
    // Brace rules capture the whole `A, B` list, single-name rules one name; splitting
    // covers both.
    const names = match[1]
      .split(',')
      .map(name => name.trim())
      .filter(name => name.length > 0)
    for (const name of names) {
      // A re-export may rename (`export { A as B }`); the shim exports B.
      const exported = name.includes(' as ') ? name.split(' as ')[1].trim() : name
      if (OMITTED.has(exported)) continue
      ;(rule.kind === 'value' ? values : types).add(exported)
    }
  }
  for (const name of OMITTED) types.delete(name)
  return {
    values: [...values].sort(compare),
    types: [...types].sort(compare),
  }
}

/**
 * Keep `TYPERT_…` constants in front, the way the declarations read.
 * @param left - first name.
 * @param right - second name.
 * @returns comparison result.
 */
function compare(left, right) {
  const shouty = /^[A-Z0-9_]+$/
  if (shouty.test(left) !== shouty.test(right)) return shouty.test(left) ? -1 : 1
  return left.localeCompare(right)
}

/**
 * Render one shim file.
 * @param entry - shim descriptor.
 * @returns file contents, newline-terminated.
 */
function render(entry) {
  const { values, types } = collectExports(entry.declaration)
  const lines = [
    '/**',
    ` * Source-plane ${entry.title} of the vendored Typert protocol.`,
    ' *',
    ` * \`lib/\` is the published build of the package — ${entry.counterpart} — and the real`,
    ' * surface of this package; see VENDOR.md. This file only puts the package in the',
    ' * planes the Typert generator needs: it makes the manifest export target map to an',
    ' * existing source file, and it keeps the protocol symbols owned by a registered',
    ' * project of the workspace aggregate tsconfig.',
    ' *',
    ' * Generated by `npm run sync-shims` — do not hand-edit the lists below.',
    ' */',
  ]
  if (values.length > 0) {
    lines.push(`export { ${values.join(', ')} } from '${entry.specifier}'`)
  }
  if (types.length > 0) {
    lines.push(`export type {`)
    for (const name of types) lines.push(`  ${name},`)
    lines.push(`} from '${entry.specifier}'`)
  }
  lines.push(
    '',
    '// Deliberately not re-exported: `TypertRegistryContract`. Its `Context.typert` member',
    '// is installed by the launcher, not by a plugin, so this package must not read as the',
    '// provider of that service to the Typert generator (which would then require a',
    '// `./typert` artifact here). See VENDOR.md.',
    '',
  )
  return lines.join('\n')
}

let stale = false
for (const entry of SHIMS) {
  const path = resolve(packageRoot, entry.shim)
  const rendered = render(entry)
  const current = (() => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  })()
  if (current === rendered) continue
  stale = true
  if (process.argv.includes('--check')) {
    console.error(`${entry.shim} is out of date — run: npm run sync-shims`)
  } else {
    writeFileSync(path, rendered)
    console.log(`wrote ${entry.shim}`)
  }
}
if (stale && process.argv.includes('--check')) process.exit(1)
if (!stale) console.log('shims are in sync with lib/')
