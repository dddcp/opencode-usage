/** @jsxImportSource @opentui/solid */
//
// opencode-usage — TUI sidebar plugin showing the remaining quota of the
// active coding-plan provider: GLM (智谱国内 open.bigmodel.cn / 国际 z.ai),
// Kimi Coding Plan, and DeepSeek (pay-as-you-go balance).
//
// Loaded by OpenCode V2 from  ~/.config/opencode/plugins/opencode-usage/tui.tsx
// (or a project-level .opencode/plugins/ copy). The same module is also read
// by the opencode server process, where `context.ui` is absent — setup then
// simply returns without registering anything.

import { Plugin } from '@opencode/plugin/tui'
import type { Context } from '@opencode/plugin/tui/context'
import type { JSX } from '@opentui/solid'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import type { UsageData, UsageRow } from './types.ts'
import { activeModelProvider, resolveUsage } from './providers/resolve.ts'

// Refresh tick shared between the plugin entry (turn-completed listener) and
// every panel instance — bumps force a reload after quota changed.
const [refreshTick, setRefreshTick] = createSignal(0)

// ---------------------------------------------------------------------------
// terminal-width helpers (CJK chars occupy 2 columns; naive padEnd breaks)
// ---------------------------------------------------------------------------

function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20)
    return 0
  if (code < 0x7F)
    return 1
  if (code < 0xA0)
    return 0
  if (
    (code >= 0x1100 && code <= 0x115F)
    || (code >= 0x2E80 && code <= 0xA4CF)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE10 && code <= 0xFE6F)
    || (code >= 0xFF01 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
    || (code >= 0x1F300 && code <= 0x1F64F)
    || (code >= 0x20000 && code <= 0x3FFFD)
  ) {
    return 2
  }
  return 1
}

function visualWidth(s: string): number {
  let w = 0
  for (const c of s)
    w += charColumns(c)
  return w
}

function padEndVisual(s: string, width: number): string {
  const pad = width - visualWidth(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

// ---------------------------------------------------------------------------
// number formatting
// ---------------------------------------------------------------------------

function compact(n: number): string {
  if (n < 1000)
    return String(Math.round(n))
  if (n < 1_000_000)
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "1h23m" / "2d4h" / "45m" countdown until `iso` from now. */
function countdown(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms))
    return ''
  const minutes = Math.max(0, Math.floor((ms - Date.now()) / 60_000))
  if (minutes < 60)
    return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

// ---------------------------------------------------------------------------
// theme helpers — ResolvedTheme colors are RGBA; spans want hex
// ---------------------------------------------------------------------------

type Unknown = Record<string, unknown>

function rgb(raw: unknown): { r: number, g: number, b: number } | null {
  if (typeof raw === 'string' && raw.startsWith('#')) {
    const h = raw.slice(1)
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
    }
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Unknown
    if (typeof o.r === 'number' && typeof o.g === 'number' && typeof o.b === 'number') {
      const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255
      return {
        r: Math.round(o.r * scale),
        g: Math.round(o.g * scale),
        b: Math.round(o.b * scale),
      }
    }
  }
  return null
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
}

function themeHex(raw: unknown, fallback: string): string {
  const c = rgb(raw)
  return c ? toHex(c.r, c.g, c.b) : fallback
}

/** Walk a theme by dot-path, tolerating structural drift across versions. */
function themeAt(theme: unknown, path: string): unknown {
  let cur: unknown = theme
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object')
      return undefined
    cur = (cur as Unknown)[part]
  }
  return cur
}

function brighten(hex: string, amount: number): string {
  const c = rgb(hex)
  if (!c)
    return hex
  return toHex(
    Math.round(c.r + (255 - c.r) * amount),
    Math.round(c.g + (255 - c.g) * amount),
    Math.round(c.b + (255 - c.b) * amount),
  )
}

const FALLBACK = {
  primary: '#8B9DAF',
  text: '#C5C5BB',
  muted: '#7A7A72',
  border: '#6B6B63',
} as const

const VIVID_FALLBACK = {
  relaxed: '#22D06E',
  warning: '#F5A623',
  danger: '#FF4D4F',
} as const

interface Palette {
  primary: string
  text: string
  muted: string
  border: string
  danger: string
}

function paletteOf(theme: unknown): Palette {
  return {
    primary: themeHex(themeAt(theme, 'text.action.primary.base') ?? themeAt(theme, 'text.base'), FALLBACK.primary),
    text: themeHex(themeAt(theme, 'text.base'), FALLBACK.text),
    muted: themeHex(themeAt(theme, 'text.muted'), FALLBACK.muted),
    border: themeHex(themeAt(theme, 'border.subtle') ?? themeAt(theme, 'border.base'), FALLBACK.border),
    danger: themeHex(
      themeAt(theme, 'text.feedback.error.base') ?? themeAt(theme, 'background.feedback.error.base'),
      VIVID_FALLBACK.danger,
    ),
  }
}

/** Severity tier: relaxed <60, warning 60-85, danger >=85. */
function tierColor(pct: number, theme: unknown): string {
  if (pct >= 85) {
    return themeHex(
      themeAt(theme, 'text.feedback.error.base') ?? themeAt(theme, 'background.feedback.error.base'),
      VIVID_FALLBACK.danger,
    )
  }
  if (pct >= 60) {
    return themeHex(
      themeAt(theme, 'text.feedback.warning.base') ?? themeAt(theme, 'background.feedback.warning.base'),
      VIVID_FALLBACK.warning,
    )
  }
  return themeHex(
    themeAt(theme, 'text.feedback.success.base') ?? themeAt(theme, 'background.feedback.success.base'),
    VIVID_FALLBACK.relaxed,
  )
}

// ---------------------------------------------------------------------------
// meter bar — slim profile: heavy line for fill, light line for track
// ---------------------------------------------------------------------------

const FILL_CHAR = '━'
const TRACK_CHAR = '─'

function meterBar(percent: number, width: number): { filled: string, empty: string } {
  const clamped = Math.max(0, Math.min(100, percent))
  const filledCount = Math.round((clamped / 100) * width)
  return {
    filled: FILL_CHAR.repeat(filledCount),
    empty: TRACK_CHAR.repeat(width - filledCount),
  }
}

// ---------------------------------------------------------------------------
// panel constants
// ---------------------------------------------------------------------------

const MIN_PANEL_WIDTH = 24
const DEFAULT_PANEL_WIDTH = 30
const LABEL_W = 7 // "Balance"
const LABEL_GAP = 1
const BAR_BRACKETS = 2
const BAR_GAP = 1
const PCT_WIDTH = 6 // " 99.9%"
const GUTTER = 6 // border(2) + padding(4)
const REFRESH_MS = 5 * 60 * 1000
const IDLE_REFRESH_DEBOUNCE_MS = 3000

// ---------------------------------------------------------------------------
// panel component
// ---------------------------------------------------------------------------

function UsagePanel(props: { context: Context }): JSX.Element {
  const { context } = props
  const [panelWidth, setPanelWidth] = createSignal(DEFAULT_PANEL_WIDTH)
  const [open, setOpen] = createSignal(true)
  let boxEl: any

  const [usage, setUsage] = createSignal<UsageData | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const provider = createMemo(() => activeModelProvider(context))
  const providerName = createMemo(() => provider()?.name || provider()?.id || 'Usage')

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await resolveUsage(context)
      setUsage(data)
    }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })

  // reload when the active provider changes (model switch) or on a refresh tick
  createEffect(() => {
    providerName()
    refreshTick()
    void load()
  })

  const pal = createMemo(() => paletteOf(context.theme))

  const sep = createMemo(() => '─'.repeat(Math.max(1, panelWidth() - GUTTER)))

  const barW = createMemo(() => {
    const overhead = LABEL_W + LABEL_GAP + BAR_BRACKETS + BAR_GAP + PCT_WIDTH + GUTTER
    return Math.max(3, panelWidth() - overhead)
  })

  const titlePad = createMemo(() => {
    const plan = usage()?.plan
    const content = `${open() ? '▼' : '▶'} ${providerName()}${plan ? ` · ${plan}` : ''}`
    return Math.max(0, panelWidth() - GUTTER - 1 - visualWidth(content))
  })

  function rowDetail(row: UsageRow): string | null {
    const parts: string[] = []
    if (row.used != null && row.limit != null && row.limit > 0)
      parts.push(`${compact(row.used)}/${compact(row.limit)}`)
    const cd = row.resetsAt != null ? countdown(row.resetsAt) : ''
    if (cd !== '')
      parts.push(`reset ${cd}`)
    return parts.length > 0 ? parts.join(' · ') : null
  }

  return (
    <box
      border={true}
      borderStyle="rounded"
      borderColor={pal().border}
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="column"
      gap={0}
      ref={boxEl}
      onSizeChange={() => {
        const w = boxEl && typeof boxEl.width === 'number' && boxEl.width > 0
          ? Math.max(MIN_PANEL_WIDTH, boxEl.width)
          : DEFAULT_PANEL_WIDTH
        setPanelWidth(prev => (prev === w ? prev : w))
      }}
    >
      <box flexDirection="row">
        <text onMouseUp={() => setOpen(o => !o)}>
          <span style={{ fg: pal().muted }}>{open() ? '▼ ' : '▶ '}</span>
          <span style={{ fg: pal().primary }}>
            <b>{providerName()}</b>
          </span>
          <Show when={usage()?.plan != null}>
            <span style={{ fg: pal().muted }}>{` · ${usage()?.plan}`}</span>
          </Show>
          <span>{' '.repeat(titlePad())}</span>
        </text>
        <text onMouseUp={() => void load()} fg={loading() ? pal().primary : pal().muted}>
          {'↻'}
        </text>
      </box>

      <Show when={open()}>
        <text fg={pal().border}>{sep()}</text>

        <Show
          when={!loading() || usage() == null}
          fallback={(
            <text>
              <span style={{ fg: pal().muted }}>{'> loading…'}</span>
            </text>
          )}
        >
          <Show
            when={error() == null}
            fallback={(
              <text>
                <span style={{ fg: pal().muted }}>{'> '}</span>
                <span style={{ fg: pal().danger }}>{error()}</span>
              </text>
            )}
          >
            <Show
              when={(usage()?.rows.length ?? 0) > 0}
              fallback={(
                <text>
                  <span style={{ fg: pal().muted }}>{'> no usage data yet'}</span>
                </text>
              )}
            >
              <For each={usage()?.rows ?? []}>
                {(row) => {
                  const color = createMemo(() => tierColor(row.percent ?? 100, context.theme))
                  const edgeColor = createMemo(() => brighten(color(), 0.45))
                  const bar = createMemo(() => meterBar(row.percent ?? 0, barW()))
                  const label = padEndVisual(row.label, LABEL_W)
                  const detail = rowDetail(row)
                  const pctLabel = () => row.percent == null ? '' : `${row.percent.toFixed(0)}%`.padStart(PCT_WIDTH)

                  return (
                    <box flexDirection="column" gap={0}>
                      <text>
                        <span style={{ fg: pal().text }}>
                          <b>{label}</b>
                        </span>
                        <Show when={row.percent != null}>
                          <span style={{ fg: pal().border }}>{' ❰'}</span>
                          <span style={{ fg: color() }}>
                            <b>{bar().filled.slice(0, -1)}</b>
                          </span>
                          <Show when={bar().filled.length > 0}>
                            <span style={{ fg: edgeColor() }}>
                              <b>{bar().filled.slice(-1)}</b>
                            </span>
                          </Show>
                          <span style={{ fg: pal().border }}>{bar().empty}</span>
                          <span style={{ fg: pal().border }}>{'❱'}</span>
                          <span style={{ fg: color() }}>
                            <b>{pctLabel()}</b>
                          </span>
                        </Show>
                        <Show when={row.text != null}>
                          <span style={{ fg: row.warn ? pal().danger : pal().text }}>
                            <b>{` ${row.text}`}</b>
                          </span>
                        </Show>
                      </text>
                      <Show when={detail != null && row.percent != null}>
                        <text>
                          <span style={{ fg: pal().muted }}>
                            {`${' '.repeat(LABEL_W + 1)}${detail}`}
                          </span>
                        </text>
                      </Show>
                    </box>
                  )
                }}
              </For>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: 'usage.quota',
  setup(context) {
    // The opencode server also reads this module; UI slots only exist in the TUI.
    if (!context.ui)
      return

    // provider list is lazy-loaded; prime it so the panel has data on first paint
    void context.data.location.provider.sync().catch(() => {})

    // bump a tick shortly after each turn completes — quota changed
    let idleDebounce: ReturnType<typeof setTimeout> | undefined
    const removeIdle = context.data.on('session.idle', () => {
      clearTimeout(idleDebounce)
      idleDebounce = setTimeout(() => setRefreshTick(t => t + 1), IDLE_REFRESH_DEBOUNCE_MS)
    })

    const disposeSlot = context.ui.slot({
      append: 'sidebar.content',
      render: () => <UsagePanel context={context} />,
    })

    return () => {
      removeIdle()
      disposeSlot()
      clearTimeout(idleDebounce)
    }
  },
})
