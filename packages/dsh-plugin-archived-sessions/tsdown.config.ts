import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

/**
 * Module specifiers the 0.1.7 web shell freezes into its shared module table.
 *
 * The shell bundle (`@deepseek-ai/dsh-web-frontend`) registers `@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-dockkit`,
 * `@deepseek-ai/dsh-client-ui-primitives` and `@deepseek-ai/dsh-client-ui-slots`
 * (plus the React family); every other package a Client half needs is loaded as its
 * own `dsh.client` module and reached either through the plugin's own `dsh.client`
 * `inject` list or through an `external` entry of the package that owns it. The
 * retired `dsh-client-runtime` / `dsh-client-web-react` are gone from 0.1.7: client
 * plugins now type against the Cordis `Context` and pull the client services in
 * through the packages that own them.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
]

const CLIENT_EXTERNALS = [...PLATFORM_MODULES]

export default defineConfig(({ env }) => {
  const client = env?.DSH_BUILD_FACE === 'client'
  if (client) {
    return [{
      name: 'dsh-plugin-archived-sessions/client',
      entry: { client: 'lib/types/client/index.js' },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      target: 'es2024',
      dts: false,
      sourcemap: true,
      clean: false,
      external: CLIENT_EXTERNALS,
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
        'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
        'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      },
      noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) || id.startsWith('@deepseek-ai/') ? undefined : true),
      outputOptions: {
        entryFileNames: 'client.js',
        banner: `window.__ModuleLoader__.load({ id: "dsh-plugin-archived-sessions", factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    }]
  }
  return [{
    name: 'dsh-plugin-archived-sessions',
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
  }]
})
