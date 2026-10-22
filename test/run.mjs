/**
 * Test runner — plain node, no framework.
 *
 *   node test/run.mjs          # unit tests (mock payloads)
 *   node test/run.mjs --live   # + live API smoke test (reads real keys from
 *                              #   ~/.config/opencode/opencode.json providers)
 *
 * Runs directly on the TypeScript sources via node's type stripping.
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { parseGlmLimits } = await import('../src/providers/glm.ts')
const { parseKimiPayload } = await import('../src/providers/kimi.ts')
const { parseDeepseekBalance } = await import('../src/providers/deepseek.ts')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  }
  catch (e) {
    failed++
    console.error(`FAIL  ${name}\n      ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// GLM — live shape captured 2026-10-22 (CREDIT_LIMIT with absolute values)
// ---------------------------------------------------------------------------

console.log('glm:')

test('classifies unit 3 as 5h and unit 6 as week, keeps absolute values', () => {
  const rows = parseGlmLimits({
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 204, remaining: 1795, percentage: 10, nextResetTime: 1792651499353 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 4625, remaining: 5374, percentage: 46, nextResetTime: 1792714626997 },
    ],
    level: 'lite',
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].label, '5h')
  assert.equal(rows[0].percent, 10)
  assert.equal(rows[0].used, 204)
  assert.equal(rows[0].limit, 2000)
  assert.ok(rows[0].resetsAt.startsWith('2026'))
  assert.equal(rows[1].label, 'Week')
  assert.equal(rows[1].percent, 46)
})

test('legacy TOKENS_LIMIT with percentage only still yields rows', () => {
  const rows = parseGlmLimits({
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 5, nextResetTime: 1792651499353 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 80 },
    ],
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].percent, 5)
  assert.equal(rows[0].used, null)
  assert.equal(rows[1].percent, 80)
})

test('ignores unrelated limit types', () => {
  const rows = parseGlmLimits({ limits: [{ type: 'SOMETHING_ELSE', unit: 3, percentage: 1 }] })
  assert.equal(rows.length, 0)
})

test('missing unit falls back to reset-time heuristic', () => {
  const rows = parseGlmLimits({
    limits: [
      { type: 'CREDIT_LIMIT', percentage: 50, nextResetTime: 200 },
      { type: 'CREDIT_LIMIT', percentage: 5 }, // no reset → 5h slot first
    ],
  })
  assert.equal(rows[0].label, '5h')
  assert.equal(rows[0].percent, 5)
  assert.equal(rows[1].label, 'Week')
})

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------

console.log('kimi:')

test('primary shape: usage (week) + limits[300min] (5h)', () => {
  const { rows } = parseKimiPayload({
    usage: { limit: '100', remaining: '84', resetTime: '2026-10-26T00:00:00Z' },
    limits: [
      { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100', resetTime: '2026-10-19T15:00:00Z' } },
    ],
    usages: { limit_5h: { used_ratio: 0, reset_time: '2026-10-19T15:00:00Z' }, limit_7d: { used_ratio: 0.1631 } },
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].label, 'Week')
  assert.equal(Math.round(rows[0].percent), 16)
  assert.equal(rows[1].label, '5h')
  assert.equal(rows[1].percent, 0) // ratio fallback did NOT duplicate the 5h row
})

test('ratio-only shape: usages.limit_7d/limit_5h', () => {
  const { rows } = parseKimiPayload({
    usages: { limit_5h: { used_ratio: 0.05 }, limit_7d: { used_ratio: 0.1631 } },
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].label, 'Week')
  assert.equal(Math.round(rows[0].percent), 16)
  assert.equal(rows[1].label, '5h')
  assert.equal(rows[1].percent, 5)
})

test('ratio above 1 clamps to 100', () => {
  const { rows } = parseKimiPayload({ usages: { limit_7d: { used_ratio: 3.5 } } })
  assert.equal(rows[0].percent, 100)
})

test('legacy data[] shape with model_name=all', () => {
  const { rows } = parseKimiPayload({
    data: [
      { model_name: 'all', limit: 1000, used: 250, resetTime: '2026-10-26T00:00:00Z' },
    ],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'Week')
  assert.equal(rows[0].percent, 25)
})

test('booster_wallet disabled → off row; enabled → ¥ ratio', () => {
  const off = parseKimiPayload({ booster_wallet: { status: 'STATUS_DISABLED' } })
  assert.equal(off.rows[0].label, 'Booster')
  assert.equal(off.rows[0].text, 'off')

  const on = parseKimiPayload({
    booster_wallet: {
      status: 'STATUS_ENABLED',
      monthlyUsed: { currency: 'CNY', priceInCents: '1234' },
      monthlyChargeLimit: { currency: 'CNY', priceInCents: '10000' },
    },
  })
  assert.equal(on.rows[0].percent, 12.34)
  assert.equal(on.rows[0].limit, 100)
})

test('empty payload {} → no rows, no crash', () => {
  const { rows } = parseKimiPayload({})
  assert.equal(rows.length, 0)
})

// ---------------------------------------------------------------------------
// DeepSeek — live shape captured 2026-10-22
// ---------------------------------------------------------------------------

console.log('deepseek:')

test('balance rows with currency symbol', () => {
  const { rows } = parseDeepseekBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '4.29', granted_balance: '0.00', topped_up_balance: '4.29' }],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'Balance')
  assert.equal(rows[0].text, '¥4.29')
  assert.equal(rows[0].warn, false)
})

test('insufficient balance flags warn', () => {
  const { rows } = parseDeepseekBalance({
    is_available: false,
    balance_infos: [{ currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }],
  })
  assert.equal(rows[0].text, '$0.00')
  assert.equal(rows[0].warn, true)
})

// ---------------------------------------------------------------------------
// live smoke test — reads provider config from opencode.json
// ---------------------------------------------------------------------------

if (process.argv.includes('--live')) {
  console.log('\nlive:')
  const configPath = join(homedir(), '.config', 'opencode', 'opencode.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const { queryGlmUsage } = await import('../src/providers/glm.ts')
  const { queryKimiUsage } = await import('../src/providers/kimi.ts')
  const { queryDeepseekBalance } = await import('../src/providers/deepseek.ts')

  for (const [id, def] of Object.entries(config.provider ?? {})) {
    const options = def.options ?? {}
    const baseURL = options.baseURL
    const apiKey = options.apiKey
    if (!baseURL || !apiKey)
      continue
    const host = baseURL.toLowerCase()
    try {
      let data
      if (host.includes('bigmodel.cn') || host.includes('z.ai'))
        data = await queryGlmUsage(apiKey, baseURL, def.name ?? id)
      else if (host.includes('kimi.com') || host.includes('moonshot'))
        data = await queryKimiUsage(apiKey, baseURL, def.name ?? id)
      else if (host.includes('deepseek'))
        data = await queryDeepseekBalance(apiKey, baseURL, def.name ?? id)
      else
        continue
      console.log(`  ok  ${id}: ${JSON.stringify(data, null, 2).split('\n').slice(0, 12).join('\n')}`)
      passed++
    }
    catch (e) {
      failed++
      console.error(`FAIL  ${id}: ${e.message}`)
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
