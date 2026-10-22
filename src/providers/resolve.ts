/**
 * Active-provider discovery and usage routing (OpenCode V2 TUI plugin API).
 *
 * The panel follows the model currently selected in the TUI prompt
 * (`context.ui.model.current()` — reactive) and only renders when that model
 * is served by GLM / Kimi / DeepSeek. Detection anchors on the provider's
 * baseURL host (users register these with custom provider ids like "lin-kimi"
 * or "my-glm"), with an id heuristic fallback.
 */

import type { Context } from '@opencode/plugin/tui/context'
import type { UsageData } from '../types.ts'
import { AuthError } from '../types.ts'
import { queryDeepseekBalance } from './deepseek.ts'
import { queryGlmUsage } from './glm.ts'
import { queryKimiUsage } from './kimi.ts'

/** Minimal structural view of a provider entry from `context.data.location.provider`. */
export interface ProviderEntry {
  id: string
  name?: string
  settings?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// classification — baseURL host first, id heuristics fallback
// ---------------------------------------------------------------------------

export interface Classification {
  kind: 'glm' | 'kimi' | 'deepseek'
  /** Model API base for building request URLs. */
  baseURL: string
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  }
  catch {
    return url.toLowerCase()
  }
}

function classifyByURL(url: string | undefined): Classification | undefined {
  if (!url)
    return undefined
  const host = hostOf(url)

  if (host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn') || host === 'bigmodel.cn')
    return { kind: 'glm', baseURL: url }
  if (host === 'z.ai' || host.endsWith('.z.ai'))
    return { kind: 'glm', baseURL: url }
  if (host === 'api.kimi.com' || host.endsWith('.kimi.com') || host.endsWith('.moonshot.ai') || host.endsWith('.moonshot.cn'))
    return { kind: 'kimi', baseURL: url }
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com'))
    return { kind: 'deepseek', baseURL: url }

  return undefined
}

function classifyById(id: string): Classification | undefined {
  const lower = id.toLowerCase()
  if (lower.startsWith('zhipuai') || lower.includes('glm'))
    return { kind: 'glm', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' }
  if (lower.startsWith('zai'))
    return { kind: 'glm', baseURL: 'https://api.z.ai/api/coding/paas/v4' }
  if (lower.includes('kimi') || lower.includes('moonshot'))
    return { kind: 'kimi', baseURL: 'https://api.kimi.com/coding/v1' }
  if (lower.includes('deepseek'))
    return { kind: 'deepseek', baseURL: 'https://api.deepseek.com' }
  return undefined
}

/** Classify a registered provider: settings.baseURL first, id heuristics fallback. */
export function classifyProvider(p: ProviderEntry): Classification | undefined {
  const baseURL = p.settings && typeof p.settings.baseURL === 'string' ? p.settings.baseURL : undefined
  return classifyByURL(baseURL) ?? classifyById(p.id)
}

// ---------------------------------------------------------------------------
// API key resolution: settings.apiKey → auth.json → env vars
// ---------------------------------------------------------------------------

const ENV_KEYS: Record<Classification['kind'], string[]> = {
  glm: ['ZAI_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'],
  kimi: ['KIMI_API_KEY', 'KIMI_CODING_API_KEY', 'MOONSHOT_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
}

/** auth.json auth-id candidates for catalog providers that authenticate via `opencode auth login`. */
const AUTH_IDS: Record<Classification['kind'], string[]> = {
  glm: ['zhipuai-coding-plan', 'zhipuai', 'zai', 'zai-coding-plan'],
  kimi: ['kimi', 'kimi-coding', 'moonshot'],
  deepseek: ['deepseek'],
}

interface AuthEntry {
  type?: string
  key?: string
}

let authCache: { at: number, value: Record<string, AuthEntry> } | undefined

function readAuthFile(): Record<string, AuthEntry> {
  if (authCache && Date.now() - authCache.at < 60_000)
    return authCache.value
  let value: Record<string, AuthEntry> = {}
  try {
    // eslint-disable-next-line ts/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const { homedir } = require('node:os') as typeof import('node:os')
    const candidates = [
      join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
      join(homedir(), 'AppData', 'Local', 'opencode', 'auth.json'),
    ]
    for (const path of candidates) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'))
        if (raw && typeof raw === 'object') {
          value = raw as Record<string, AuthEntry>
          break
        }
      }
      catch { /* try next candidate */ }
    }
  }
  catch { /* no fs access — settings/env still work */ }
  authCache = { at: Date.now(), value }
  return value
}

/** API key: settings.apiKey → provider auth.json entry → env vars. */
export function resolveApiKey(p: ProviderEntry, kind: Classification['kind']): string | undefined {
  const fromSettings = p.settings && typeof p.settings.apiKey === 'string' ? p.settings.apiKey : undefined
  if (fromSettings)
    return fromSettings

  const auth = readAuthFile()
  for (const id of AUTH_IDS[kind]) {
    const entry = auth[id]
    if (entry?.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0)
      return entry.key
  }

  for (const name of ENV_KEYS[kind] ?? []) {
    const value = process.env[name]
    if (typeof value === 'string' && value.length > 0)
      return value
  }
  return undefined
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * The provider of the model currently selected in the TUI prompt.
 * Reactive when called inside a Solid computation — `ui.model.current()` is
 * backed by a live store.
 */
export function activeModelProvider(context: Context): ProviderEntry | undefined {
  const model = context.ui.model.current()
  if (!model)
    return undefined
  const list = context.data.location.provider.list()
  return list?.find(p => p.id === model.providerID)
}

/**
 * Resolve current usage by routing to the active provider's adapter.
 *
 * @throws {AuthError} key invalid or missing for the provider.
 * @throws {Error} no active provider / unsupported provider / adapter failure.
 */
export async function resolveUsage(context: Context): Promise<UsageData> {
  const p = activeModelProvider(context)
  if (!p)
    throw new Error('no active provider')

  const cls = classifyProvider(p)
  if (!cls)
    throw new Error(`provider "${p.id}" is not GLM / Kimi / DeepSeek`)

  const key = resolveApiKey(p, cls.kind)
  if (!key) {
    throw new AuthError(
      `no API key for "${p.id}" (settings.apiKey / auth.json / ${(ENV_KEYS[cls.kind] ?? []).join(' / ')})`,
    )
  }

  const title = p.name || p.id
  switch (cls.kind) {
    case 'glm':
      return queryGlmUsage(key, cls.baseURL, title)
    case 'kimi':
      return queryKimiUsage(key, cls.baseURL, title)
    case 'deepseek':
      return queryDeepseekBalance(key, cls.baseURL, title)
  }
}
