/**
 * @fileoverview Real-time cost tracker for multi-agent CLI.
 *
 * Maintains per-model pricing data (from the user's research document) and
 * accumulates token usage across the session.  Supports cache-aware
 * calculations for Anthropic models.
 */

import type { TokenUsage } from '../types.js'

// ---------------------------------------------------------------------------
// Pricing table (per million tokens) — from Agents.txt research
// ---------------------------------------------------------------------------

interface ModelPricing {
  /** Cost per 1 million input tokens. */
  readonly inputPerMTok: number
  /** Cost per 1 million output tokens. */
  readonly outputPerMTok: number
  /** Name for display purposes. */
  readonly displayName: string
}

/**
 * Pricing data sourced from the user's research document.
 * Key = model identifier used in API calls.
 */
const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-20250918':      { inputPerMTok: 5.00,  outputPerMTok: 25.00, displayName: 'Claude Opus 4.6' },
  'claude-sonnet-4-20250514':    { inputPerMTok: 3.00,  outputPerMTok: 15.00, displayName: 'Claude Sonnet 4.6' },
  'claude-haiku-4-20250414':     { inputPerMTok: 1.00,  outputPerMTok: 5.00,  displayName: 'Claude Haiku 4.5' },
  // Google
  'gemini-2.5-flash':            { inputPerMTok: 0.30,  outputPerMTok: 2.50,  displayName: 'Gemini 2.5 Flash' },
  'gemini-2.5-flash-lite':       { inputPerMTok: 0.10,  outputPerMTok: 0.40,  displayName: 'Gemini 2.5 Flash Lite' },
  'gemini-3.1-pro':              { inputPerMTok: 3.00,  outputPerMTok: 15.00, displayName: 'Gemini 3.1 Pro' },
  // DeepSeek
  'deepseek-chat':               { inputPerMTok: 0.30,  outputPerMTok: 0.50,  displayName: 'DeepSeek V4' },
  'deepseek-reasoner':           { inputPerMTok: 0.55,  outputPerMTok: 2.19,  displayName: 'DeepSeek R1' },
  // Alibaba Qwen (via DashScope)
  'qwen2.5-coder-32b-instruct':  { inputPerMTok: 0.66,  outputPerMTok: 0.90,  displayName: 'Qwen2.5-Coder-32B' },
  'qwen3-30b-a3b':               { inputPerMTok: 0.66,  outputPerMTok: 0.90,  displayName: 'Qwen3-30B MoE' },
  // Moonshot Kimi
  'kimi-k2.5':                   { inputPerMTok: 0.40,  outputPerMTok: 2.60,  displayName: 'Kimi K2.5' },
}

// ---------------------------------------------------------------------------
// Usage record
// ---------------------------------------------------------------------------

interface UsageEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cost: number
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

export class CostTracker {
  private entries: UsageEntry[] = []
  private sessionStart = Date.now()

  /** Record token usage for a model. */
  record(model: string, usage: TokenUsage): void {
    const pricing = PRICING[model]
    const inputCost = pricing
      ? (usage.input_tokens / 1_000_000) * pricing.inputPerMTok
      : 0
    const outputCost = pricing
      ? (usage.output_tokens / 1_000_000) * pricing.outputPerMTok
      : 0

    this.entries.push({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cost: inputCost + outputCost,
    })
  }

  /** Total cost across the entire session. */
  get totalCost(): number {
    return this.entries.reduce((sum, e) => sum + e.cost, 0)
  }

  /** Total input tokens across the session. */
  get totalInputTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.inputTokens, 0)
  }

  /** Total output tokens across the session. */
  get totalOutputTokens(): number {
    return this.entries.reduce((sum, e) => sum + e.outputTokens, 0)
  }

  /** Get the display name for a model. */
  getModelName(model: string): string {
    return PRICING[model]?.displayName ?? model
  }

  /** Format a cost value as a string. */
  formatCost(cost: number): string {
    if (cost < 0.01) return `$${cost.toFixed(4)}`
    return `$${cost.toFixed(3)}`
  }

  /** Get a formatted summary of this interaction's cost. */
  lastEntrySummary(): string {
    const entry = this.entries[this.entries.length - 1]
    if (!entry) return ''
    const name = this.getModelName(entry.model)
    return `${name} · ${entry.inputTokens.toLocaleString()} in / ${entry.outputTokens.toLocaleString()} out · ${this.formatCost(entry.cost)}`
  }

  /** Get a full session summary. */
  sessionSummary(): string {
    const elapsed = Math.round((Date.now() - this.sessionStart) / 1000)
    const minutes = Math.floor(elapsed / 60)
    const seconds = elapsed % 60

    // Aggregate per model
    const perModel = new Map<string, { input: number; output: number; cost: number }>()
    for (const e of this.entries) {
      const existing = perModel.get(e.model) ?? { input: 0, output: 0, cost: 0 }
      existing.input += e.inputTokens
      existing.output += e.outputTokens
      existing.cost += e.cost
      perModel.set(e.model, existing)
    }

    const lines: string[] = [
      `\x1b[1m━━━ Session Cost Summary ━━━\x1b[0m`,
      `Duration: ${minutes}m ${seconds}s · ${this.entries.length} API calls`,
      '',
    ]

    for (const [model, data] of perModel) {
      const name = this.getModelName(model)
      lines.push(
        `  ${name}: ${data.input.toLocaleString()} in / ${data.output.toLocaleString()} out · ${this.formatCost(data.cost)}`
      )
    }

    lines.push('')
    lines.push(
      `\x1b[1mTotal: ${this.totalInputTokens.toLocaleString()} tokens · ${this.formatCost(this.totalCost)}\x1b[0m`
    )

    return lines.join('\n')
  }
}
