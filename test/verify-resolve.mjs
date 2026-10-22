/**
 * End-to-end verification of resolveUsage() with a mocked V2 TUI context.
 * Reads the user's real provider config from ~/.config/opencode/opencode.json
 * and queries every configured GLM / Kimi / DeepSeek provider live.
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { resolveUsage, classifyProvider } = await import('../src/providers/resolve.ts')

const config = JSON.parse(readFileSync(join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'))

function makeContext(providerID) {
  return {
    ui: { model: { current: () => ({ providerID, modelID: 'test' }) } },
    data: { location: { provider: { list: () => Object.entries(config.provider ?? {}).map(([id, def]) => ({
      id,
      name: def.name ?? id,
      settings: def.options,
    })) } } },
  }
}

let failures = 0
for (const [id, def] of Object.entries(config.provider ?? {})) {
  const entry = { id, name: def.name ?? id, settings: def.options }
  const cls = classifyProvider(entry)
  if (!cls)
    continue
  try {
    const data = await resolveUsage(makeContext(id))
    const summary = data.rows.map(r =>
      r.percent != null ? `${r.label} ${r.percent.toFixed(0)}%` : `${r.label} ${r.text}`,
    ).join(', ')
    console.log(`  ok  ${id} [${cls.kind}] → ${data.title}${data.plan ? ` (${data.plan})` : ''}: ${summary || '(empty rows)'}`)
  }
  catch (e) {
    failures++
    console.error(`FAIL  ${id} [${cls.kind}]: ${e.message}`)
  }
}

// unsupported provider must throw a clear error
try {
  await resolveUsage(makeContext('opencode'))
  console.error('FAIL  opencode (unsupported) did not throw')
  failures++
}
catch (e) {
  console.log(`  ok  unsupported provider rejected: ${e.message}`)
}

console.log(failures === 0 ? '\nall resolve checks passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
