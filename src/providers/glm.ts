/**
 * GLM coding-plan usage adapter — 智谱国内 (open.bigmodel.cn) and global (api.z.ai).
 *
 * Both presets share one quota backend and response shape. Verified against
 * live responses on 2026-10-22:
 *
 *   GET {base}/api/monitor/usage/quota/limit
 *   Authorization: <apiKey>          (raw key — NO "Bearer " prefix)
 *
 *   {
 *     "code": 200, "msg": "Operation successful", "success": true,
 *     "data": {
 *       "limits": [
 *         { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 2000,
 *           "currentValue": 204, "remaining": 1795, "percentage": 10,
 *           "nextResetTime": 1792651499353 },
 *         { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 10000, ... }
 *       ],
 *       "level": "lite"
 *     }
 *   }
 *
 * `unit: 3` is the 5-hour rolling window, `unit: 6` the weekly window. Older
 * plans used `type: "TOKENS_LIMIT"` with only `percentage`; both variants are
 * accepted. Business errors (bad key) can come back with HTTP 200, so the
 * `code`/`success` body fields must be checked.
 */

import { AuthError, type UsageData, type UsageRow } from '../types.ts'

const REQUEST_TIMEOUT_MS = 15_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Route the quota host from the user's model baseURL. No cross-host fallback. */
export function glmQuotaBase(baseURL: string): string {
  return baseURL.toLowerCase().includes('bigmodel.cn')
    ? 'https://open.bigmodel.cn'
    : 'https://api.z.ai'
}

type WindowKey = 'fiveHour' | 'week'

function classifyWindow(item: Record<string, unknown>): WindowKey | undefined {
  const unit = asFiniteNumber(item.unit)
  if (unit === 3)
    return 'fiveHour'
  if (unit === 6)
    return 'week'
  return undefined
}

const LABELS: Record<WindowKey, string> = {
  fiveHour: '5h',
  week: 'Week',
}

function toRow(key: WindowKey, item: Record<string, unknown>): UsageRow {
  const percentage = asFiniteNumber(item.percentage) ?? null
  const limit = asFiniteNumber(item.usage) ?? null
  const used = asFiniteNumber(item.currentValue) ?? null
  const resetMs = asFiniteNumber(item.nextResetTime)
  return {
    label: LABELS[key],
    percent: percentage,
    used,
    limit,
    text: null,
    resetsAt: resetMs != null ? new Date(resetMs).toISOString() : null,
  }
}

/**
 * Parse `data.limits[]` into the two windows GLM exposes.
 *
 * Classification anchors on `unit` only (both `unit:6, number:7` and
 * `unit:6, number:1` have been observed for the weekly window). When `unit`
 * is missing, entries without a reset time fill the 5-hour slot first (it
 * legitimately has no reset at 0% utilisation), the rest sort by reset time.
 */
export function parseGlmLimits(data: Record<string, unknown>): UsageRow[] {
  let fiveHour: UsageRow | undefined
  let week: UsageRow | undefined
  const unclassified: { resetMs: number | undefined, item: Record<string, unknown> }[] = []

  const limits = data.limits
  if (Array.isArray(limits)) {
    for (const raw of limits) {
      if (!isRecord(raw))
        continue
      const type = (asString(raw.type) ?? '').toLowerCase()
      if (type !== 'credit_limit' && type !== 'tokens_limit')
        continue

      const slot = classifyWindow(raw)
      if (slot === 'fiveHour' && fiveHour == null) {
        fiveHour = toRow(slot, raw)
      }
      else if (slot === 'week' && week == null) {
        week = toRow(slot, raw)
      }
      else {
        unclassified.push({ resetMs: asFiniteNumber(raw.nextResetTime), item: raw })
      }
    }
  }

  if (fiveHour == null || week == null) {
    unclassified.sort((a, b) => {
      const aHas = a.resetMs != null ? 1 : 0
      const bHas = b.resetMs != null ? 1 : 0
      if (aHas !== bHas)
        return aHas - bHas
      return (a.resetMs ?? Number.NEGATIVE_INFINITY) - (b.resetMs ?? Number.NEGATIVE_INFINITY)
    })
    for (const { item } of unclassified) {
      if (fiveHour == null)
        fiveHour = toRow('fiveHour', item)
      else if (week == null)
        week = toRow('week', item)
    }
  }

  const rows: UsageRow[] = []
  if (fiveHour != null)
    rows.push(fiveHour)
  if (week != null)
    rows.push(week)
  return rows
}

/**
 * Query the current GLM coding-plan usage.
 *
 * @throws {AuthError} invalid or expired API key.
 * @throws {Error} network failure or malformed body.
 */
export async function queryGlmUsage(apiKey: string, baseURL: string, title: string): Promise<UsageData> {
  const url = `${glmQuotaBase(baseURL)}/api/monitor/usage/quota/limit`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await globalThis.fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        // GLM wants the raw API key — no "Bearer " prefix.
        'Authorization': apiKey,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
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
  let body: unknown
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined
  }
  catch {
    throw new Error(`HTTP ${resp.status}: malformed JSON response`)
  }

  if (isRecord(body)) {
    const code = asFiniteNumber(body.code)
    const success = body.success
    if (success === false || (code != null && code !== 200)) {
      if (code === 401 || code === 403)
        throw new AuthError(`GLM: invalid or expired API key (code ${code})`)
      throw new Error(`GLM API error (code ${code ?? 'unknown'}): ${asString(body.msg) ?? 'unknown error'}`)
    }
  }
  if (!resp.ok)
    throw new Error(`GLM: HTTP ${resp.status}`)

  const data = isRecord(body) ? body.data : undefined
  if (!isRecord(data))
    throw new Error('GLM: missing \'data\' field in response')

  const level = asString(data.level)
  return {
    kind: 'glm',
    title,
    plan: level != null && level.length > 0 ? level.charAt(0).toUpperCase() + level.slice(1) : null,
    rows: parseGlmLimits(data),
  }
}
