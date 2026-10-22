/**
 * DeepSeek balance adapter (pay-as-you-go — DeepSeek has no coding plan).
 *
 *   GET {base}/user/balance
 *   Authorization: Bearer <api key>
 *
 *   {
 *     "is_available": true,
 *     "balance_infos": [
 *       { "currency": "CNY", "total_balance": "4.29",
 *         "granted_balance": "0.00", "topped_up_balance": "4.29" }
 *     ]
 *   }
 *
 * Verified live on 2026-10-22.
 */

import { AuthError, type UsageData, type UsageRow } from '../types.ts'

const REQUEST_TIMEOUT_MS = 15_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$' }

/** Parse a balance payload into display rows. Exported for tests. */
export function parseDeepseekBalance(payload: Record<string, unknown>): { rows: UsageRow[] } {
  const rows: UsageRow[] = []
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
  for (const info of infos) {
    if (!isRecord(info))
      continue
    const currency = typeof info.currency === 'string' ? info.currency : ''
    const total = typeof info.total_balance === 'string' ? Number.parseFloat(info.total_balance) : Number.NaN
    if (!Number.isFinite(total))
      continue
    const symbol = SYMBOLS[currency] ?? `${currency} `
    rows.push({
      label: 'Balance',
      percent: null,
      used: null,
      limit: null,
      text: `${symbol}${total.toFixed(2)}`,
      resetsAt: null,
      warn: payload.is_available === false,
    })
  }
  return { rows }
}

/**
 * Query the DeepSeek account balance.
 *
 * @throws {AuthError} invalid API key (HTTP 401).
 * @throws {Error} network failure or unexpected status.
 */
export async function queryDeepseekBalance(apiKey: string, baseURL: string, title: string): Promise<UsageData> {
  const url = `${baseURL.replace(/\/+$/, '')}/user/balance`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await globalThis.fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    })
  }
  catch (e) {
    throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`)
  }
  finally {
    clearTimeout(timer)
  }

  if (resp.status === 401)
    throw new AuthError('DeepSeek: invalid API key')
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`DeepSeek: HTTP ${resp.status} ${text.slice(0, 120)}`)
  }

  let payload: unknown
  try {
    payload = await resp.json()
  }
  catch {
    throw new Error('DeepSeek: malformed JSON response')
  }
  if (!isRecord(payload))
    throw new Error('DeepSeek: unexpected response shape')

  return { kind: 'deepseek', title, plan: null, rows: parseDeepseekBalance(payload).rows }
}
