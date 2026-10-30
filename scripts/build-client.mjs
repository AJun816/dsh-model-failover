/** Build lib/client.js in the browser combo format: __ModuleLoader__.load({id, factory}). */
import { build } from 'esbuild'

const banner = 'window.__ModuleLoader__.load({\n  id: "dsh-model-failover",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;'
const footer = '    return module.exports;\n  }\n});'

await build({
  entryPoints: ['src/client.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  outfile: 'lib/client.js',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots'],
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
})
