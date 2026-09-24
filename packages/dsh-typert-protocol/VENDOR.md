# Vendored `@deepseek-ai/dsh-typert-protocol`

This directory is a **workspace package whose runtime and declarations are a verbatim
copy of the published `@deepseek-ai/dsh-typert-protocol@0.1.7-rc.1` build**, not source
that this repository compiles. `lib/` is checked in (an exception in `.gitignore`).

## Why it lives here at all

The Typert generator (`@deepseek-ai/dsh-typert-generator`) only recognises
`Remote` / `RemoteScope` / `TypertRemoteService` when their declarations come from a
package it registered through the **aggregate tsconfig's `projectReferences`**, and
`WorkspaceAnalyzer.loadRegistrations()` only accepts referenced projects that live
under `<workspace root>/packages` or `vendor`. A plugin repo therefore has to keep the
protocol inside `packages/`; resolving it from `node_modules` makes every Remote
method invisible (`publishes Remote artifacts but has no Remote methods`).

It also has to be a *source* package for the analyzer, which maps each published export
target back to source (`lib/types/<name>.d.ts` → `src/<name>.ts`) and looks that file up
in its TypeScript program. That is what `src/index.ts` and `src/types.ts` are: one-line
re-exports that put the protocol's declarations in the source plane without duplicating
them.

The 0.1.7 program only *selects* packages that show a surface marker
(`sourceFileHasSurface`), and the marker that makes the protocol a contributor is the
`declare module '@deepseek-ai/cordis'` augmentation inside `lib/types/types.d.ts`.

## Updating it

```bash
# from the workspace root, with the published version installed as a devDependency
rm -rf packages/dsh-typert-protocol/lib
cp -r node_modules/@deepseek-ai/dsh-typert-protocol/lib packages/dsh-typert-protocol/lib
```

Then bump `version` in this package's `package.json` (and the generator pin in the root
`package.json`) and re-run `npm run build`. Do **not** hand-edit `lib/`: it is the
upstream build output.

## What this replaced

Before 0.1.7 this directory carried a hand-copied tree of upstream *source*
(`src/index.ts`, `src/types.ts`, `src/invariant.ts` at 0.1.0-rc.5, plus upstream tests)
that `tsc` compiled into `lib/`. That source is not published to npm and no longer
matched the 0.1.7 runtime, so it was dropped in favour of the published build.
