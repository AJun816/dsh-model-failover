#!/usr/bin/env node
/**
 * check-health.mjs — mechanical guards that keep the plugin loadable across DSH
 * upgrades and catch the regressions this project has already paid for.
 *
 * Run: node scripts/check-health.mjs   (also part of `pnpm health`)
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checks = []

const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  if (!ok) failures.push(detail === '' ? name : name + ' — ' + detail)
}
const read = (p) => readFileSync(join(root, p), 'utf8')
const pkg = JSON.parse(read('package.json'))

// 1. Version consistency across the three places that must agree.
const srcVersion = /VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1]
const libVersion = /VERSION = '([^']+)'/.exec(read('lib/version.js'))?.[1]
check('version: package.json = src/version.ts = lib/version.js', pkg.version === srcVersion && pkg.version === libVersion,
  'package=' + pkg.version + ' src=' + srcVersion + ' lib=' + libVersion)

// 2. Required published artifacts exist.
for (const file of ['lib/index.js', 'lib/client.js', 'lib/config.js', 'lib/probe.js', 'lib/cooldowns.js', 'lib/diag.js']) {
  check('artifact exists: ' + file, existsSync(join(root, file)))
}

// 3. The schema library is the ONLY runtime dependency and must stay optional:
//    a static import would make a DSH/schema upgrade a load-time failure.
const configSrc = read('src/config.ts')
const configLib = read('lib/config.js')
check('schema library imported dynamically (src)', !/^import\s+\w+\s+from\s+'@deepseek-ai\/schemastery'/m.test(configSrc))
check('schema library imported dynamically (lib)', !/require\('@deepseek-ai\/schemastery'\)/.test(configLib) && /import\('@deepseek-ai\/schemastery'\)/.test(configLib))

// 4. No other static runtime import from the host packages in the server build.
const serverFiles = ['lib/index.js', 'lib/config.js', 'lib/pool.js', 'lib/probe.js', 'lib/records.js', 'lib/cooldowns.js', 'lib/diag.js']
for (const file of serverFiles) {
  const text = read(file)
  const staticHostImport = /^import\s[^;]*from\s+'@deepseek-ai\/[^']+'/m.test(text)
  check('no static host import: ' + file, !staticHostImport)
}

// 5. Session writes must go through appendPluginRecord only (history-load guard).
for (const file of serverFiles) {
  check('no direct session.append in ' + file, !/session\s*\.\s*append\s*\(/.test(read(file)))
}

// 6. Every listener is registered through safeOn (one ctx.on call, inside it).
const listeners = (read('lib/index.js').match(/ctx\.on\(/g) ?? []).length
check('single guarded listener registration', listeners <= 1, 'found ' + listeners + ' raw ctx.on calls')

// 7. No debug output left in the server build.
for (const file of serverFiles) {
  check('no console.log in ' + file, !/console\.log\s*\(/.test(read(file)))
}

for (const c of checks) console.log((c.ok ? '✅ ' : '❌ ') + c.name + (c.ok || c.detail === '' ? '' : ' — ' + c.detail))
console.log('\n' + (failures.length === 0
  ? 'health: OK (' + checks.length + ' checks)'
  : 'health: FAILED (' + failures.length + '/' + checks.length + ')'))
process.exitCode = failures.length === 0 ? 0 : 1
