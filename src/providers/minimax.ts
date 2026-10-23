/**
 * MiniMax Token/Coding Plan usage adapter — China (api.minimaxi.com) and
 * global (api.minimax.io).
 *
 *   GET {base}/v1/token_plan/remains
 *   Authorization: Bearer <apiKey>
 *
 *   {
 *     "model_remains": [
 *       { "model_name": "MiniMax-M2",
 *         "start_time": 1771000000000, "end_time": 1771018000000,
 *         "remains_time": 10800000,
 *         "current_interval_total_count": 4500,
 *         "current_interval_usage_count": 4309,
 *         "current_interval_remaining_percent": 95.8,
 *         "current_interval_status": 1,
 *         "weekly_start_time": ..., "weekly_end_time": ..., "weekly_remains_time": ...,
 *         "current_weekly_total_count": 157500,
 *         "current_weekly_usage_count": 155409,
 *         "current_weekly_remaining_percent": 98.67,
 *         "weekly_boost_permille": 1000,
 *         "current_weekly_status": 1 }
 *     ]
 *   }
 *
 * Naming trap: `current_interval_usage_count` / `current_weekly_usage_count`
 * hold the REMAINING request count, not the used one (used = total - value);
 * `*_remaining_percent` is 0-100 remaining. Cross-checked against the official
 * docs (platform.minimax.io m-plan FAQ), oc-minimax-status and the MiniMaxUsage
 * macOS app on 2026-10-23. Business errors come back as
 * `{ "base_resp": { "status_code": !=0, "status_msg": "..." } }`. Window
 * `status == 3` means unlimited. Counts are request counts (次), windows start
 * at first use and reset independently.
 */

import { AuthError, type UsageData, type UsageRow } from '../types.ts'

const REQUEST_TIMEOUT_MS = 15_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v))
    return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n))
      return n
  }
  return undefined
}

function clamp100(n: number): number {
  return Math.max(0, Math.min(100, n))
}

/** Route the quota host from the user's model baseURL (api.minimax.io → global, everything else → China). */
export function minimaxQuotaBase(baseURL: string): string {
  let host = ''
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  }
  catch {
    host = baseURL.toLowerCase()
  }
  if (host === 'minimax.io' || host.endsWith('.minimax.io'))
    return 'https://api.minimax.io'
  // minimaxi.com, legacy minimaxi.chat and www hosts all share the China backend
  return 'https://api.minimaxi.com'
}

type WindowPrefix = 'current_interval' | 'current_weekly'

/**
 * One quota window → row. `*_usage_count` is the remaining count,
 * `*_remaining_percent` (0-100) the remaining share; `*_status == 3` is
 * unlimited. Reset anchors on `end_time` / `weekly_end_time` (epoch ms).
 */
function windowRow(label: string, item: Record<string, unknown>, prefix: WindowPrefix): UsageRow | null {
  const status = toFiniteNumber(item[`${prefix}_status`])
  if (status === 3)
    return { label, percent: null, used: null, limit: null, text: '∞', resetsAt: null }

  const total = toFiniteNumber(item[`${prefix}_total_count`])
  const remaining = toFiniteNumber(item[`${prefix}_usage_count`])
  const remainingPercent = toFiniteNumber(item[`${prefix}_remaining_percent`])
  const resetMs = toFiniteNumber(item[prefix === 'current_interval' ? 'end_time' : 'weekly_end_time'])

  let used: number | null = null
  if (total != null && total > 0 && remaining != null)
    used = Math.max(0, total - remaining)

  let percent: number | null = null
  if (remainingPercent != null)
    percent = clamp100(100 - remainingPercent)
  else if (used != null && total != null && total > 0)
    percent = clamp100((used / total) * 100)

  if (used == null && percent == null)
    return null

  return {
    label,
    percent,
    used,
    limit: total != null && total > 0 ? total : null,
    text: null,
    resetsAt: resetMs != null && resetMs > 0 ? new Date(resetMs).toISOString() : null,
  }
}

/**
 * Parse a `/v1/token_plan/remains` payload into the 5h + weekly rows.
 * `model_remains` can hold several models; an `all` entry is preferred,
 * otherwise the first. Exported for tests.
 */
export function parseMinimaxRemains(data: Record<string, unknown>): { rows: UsageRow[], modelName: string | null } {
  const list = Array.isArray(data.model_remains) ? data.model_remains.filter(isRecord) : []
  const entry = list.find(e => String(e.model_name ?? '').toLowerCase() === 'all') ?? list[0]
  if (entry == null)
    return { rows: [], modelName: null }

  const rows = [
    windowRow('5h', entry, 'current_interval'),
    windowRow('Week', entry, 'current_weekly'),
  ].filter((r): r is UsageRow => r != null)

  const modelName = typeof entry.model_name === 'string' ? entry.model_name : null
  return { rows, modelName }
}

/**
 * Query the current MiniMax Token/Coding Plan usage.
 *
 * @throws {AuthError} invalid key or non-plan (open-platform) key.
 * @throws {Error} network failure or unexpected status.
 */
export async function queryMinimaxUsage(apiKey: string, baseURL: string, title: string): Promise<UsageData> {
  const url = `${minimaxQuotaBase(baseURL)}/v1/token_plan/remains`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await globalThis.fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
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

  const bodyText = await resp.text().catch(() => '')
  let payload: unknown
  try {
    payload = bodyText ? JSON.parse(bodyText) : {}
  }
  catch {
    throw new Error(`MiniMax: HTTP ${resp.status}: malformed JSON response`)
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new AuthError('MiniMax: auth failed. Requires a Token/Coding Plan API key')
  }
  if (isRecord(payload)) {
    const baseResp = isRecord(payload.base_resp) ? payload.base_resp : undefined
    const statusCode = baseResp != null ? toFiniteNumber(baseResp.status_code) : undefined
    if (statusCode != null && statusCode !== 0) {
      if (statusCode === 401 || statusCode === 403)
        throw new AuthError(`MiniMax: invalid or expired API key (code ${statusCode})`)
      const msg = typeof baseResp?.status_msg === 'string' ? baseResp.status_msg : 'unknown error'
      throw new Error(`MiniMax API error (code ${statusCode}): ${msg}`)
    }
  }
  if (!resp.ok)
    throw new Error(`MiniMax: HTTP ${resp.status} ${bodyText.slice(0, 120)}`)

  const record = isRecord(payload) ? payload : {}
  return { kind: 'minimax', title, plan: null, rows: parseMinimaxRemains(record).rows }
}
