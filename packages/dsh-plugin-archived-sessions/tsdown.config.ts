import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

/** Module specifiers the DSH web shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

/** Additional runtime services this plugin collaborates with through cordis. */
const RUNTIME_EXTERNALS = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-conversation',
]

const CLIENT_EXTERNALS = [...PLATFORM_MODULES, ...RUNTIME_EXTERNALS]

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
