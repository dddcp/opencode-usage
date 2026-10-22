/**
 * Data contract between provider adapters and the sidebar panel.
 *
 * Adapters only need to produce a {@link UsageData}; the panel does not care
 * where it came from.
 */

export type ProviderKind = 'glm' | 'kimi' | 'deepseek'

/**
 * One row of quota info.
 *
 * Percentage rows (`percent != null`) render a progress bar; text rows
 * (`text != null`, e.g. a DeepSeek balance) render a plain value line.
 */
export interface UsageRow {
  label: string
  /** Utilisation 0–100, or null when the provider reports no ratio. */
  percent: number | null
  /** Absolute usage in the provider's unit (credits / requests), if exposed. */
  used: number | null
  /** Absolute allowance in the same unit, if exposed. */
  limit: number | null
  /** Text value for non-ratio rows, e.g. `¥4.29`. */
  text: string | null
  /** ISO-8601 timestamp at which the window resets, if exposed. */
  resetsAt: string | null
  /** Render the value in the danger color (e.g. insufficient balance). */
  warn?: boolean
}

export interface UsageData {
  kind: ProviderKind
  /** Panel title — the provider display name. */
  title: string
  /** Plan tier, e.g. `Lite`, `GLM Max`. May be null. */
  plan: string | null
  rows: UsageRow[]
}

/** Authentication failed — the panel renders a dedicated hint for this. */
export class AuthError extends Error {
  name = 'AuthError'
}
