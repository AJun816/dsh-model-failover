// Test loader: isolate plugin file-writes from the real ~/.dsh.
// DSH_HOME must be set BEFORE the module under test is imported anywhere in
// the test process (writeLoadMarker resolves the home lazily per call).
if (process.env.DSH_MODEL_FAILOVER_TEST_HOME === undefined) {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  process.env.DSH_MODEL_FAILOVER_TEST_HOME = mkdtempSync(join(tmpdir(), 'mf-test-'))
}
process.env.DSH_HOME = process.env.DSH_MODEL_FAILOVER_TEST_HOME
const { register } = await import('node:module')
const { pathToFileURL } = await import('node:url')
register(new URL('./hook.mjs', import.meta.url))
