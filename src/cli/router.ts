/**
 * @fileoverview Hybrid model router for sub-routing within modes.
 *
 * Uses a 3-tier routing strategy:
 * 1. /force override (user explicit)
 * 2. AI classification via Gemini 2.5 Flash Lite (smart, ~$0.00005/call)
 * 3. Keyword matching fallback (free, instant)
 *
 * The AI classifier sends a tiny prompt to Flash Lite asking it to
 * classify the task type. If GOOGLE_AI_API_KEY is not set, it falls
 * back to keyword matching silently.
 */

import type { ModeConfig, SubRoute } from './mode-config.js'
import type { SupportedProvider } from '../llm/adapter.js'

// ---------------------------------------------------------------------------
// Router result
// ---------------------------------------------------------------------------

export interface RouteResult {
  /** Model to use for this request. */
  readonly model: string
  /** Provider for this model. */
  readonly provider: SupportedProvider
  /** Which sub-route was selected (null = primary model). */
  readonly subRouteLabel: string | null
  /** Reason for the routing decision. */
  readonly reason: string
}

// ---------------------------------------------------------------------------
// AI Classifier — Gemini 2.5 Flash Lite
// ---------------------------------------------------------------------------

/**
 * Uses Gemini 2.5 Flash Lite (~$0.10/$0.40 per MTok) to classify
 * the user's prompt into one of the available sub-routes.
 *
 * Total cost per classification: ~$0.00005 (practically free)
 */
async function aiClassify(
  userPrompt: string,
  subRoutes: readonly SubRoute[],
  modeDescription: string,
): Promise<string | null> {
  const apiKey = process.env.GOOGLE_AI_API_KEY
  if (!apiKey) return null // no key = fall back to keywords

  const labels = subRoutes.map(r => `"${r.label}": ${r.description}`).join('\n')

  const classificationPrompt = `You are a task classifier for a coding assistant. Given a user's coding request, classify it into one of these categories. Reply with ONLY the label, nothing else.

Categories:
"primary": Default — complex multi-file work, integration tasks, anything that doesn't clearly fit below
${labels}

User request: "${userPrompt.slice(0, 500)}"

Classification:`

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: classificationPrompt }] }],
          generationConfig: {
            maxOutputTokens: 20,
            temperature: 0.0,
          },
        }),
        signal: AbortSignal.timeout(3000), // 3s timeout — if slow, fall through
      },
    )

    if (!response.ok) return null

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase()
    if (!text) return null

    // Clean up response — Flash Lite might add quotes or punctuation
    const cleaned = text.replace(/["'`\s.]/g, '')

    // Validate it's a real label
    if (cleaned === 'primary') return 'primary'
    const match = subRoutes.find(r => r.label === cleaned)
    return match ? cleaned : null

  } catch {
    // Timeout, network error, etc. — silently fall back to keywords
    return null
  }
}

// ---------------------------------------------------------------------------
// Keyword Classifier (fallback)
// ---------------------------------------------------------------------------

function keywordClassify(
  userPrompt: string,
  subRoutes: readonly SubRoute[],
): SubRoute | null {
  const lowerPrompt = userPrompt.toLowerCase()

  let bestRoute: SubRoute | null = null
  let bestScore = 0

  for (const route of subRoutes) {
    let score = 0
    for (const kw of route.keywords) {
      if (lowerPrompt.includes(kw.toLowerCase())) {
        score++
      }
    }
    if (score > bestScore) {
      bestScore = score
      bestRoute = route
    }
  }

  // Require at least 2 keyword matches to prevent spurious routing
  return bestScore >= 2 ? bestRoute : null
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class ModelRouter {
  private forceOverride: string | null = null
  private useAI: boolean = true

  /**
   * Set a one-shot force override for the next routing decision.
   * Pass null to clear.
   */
  setForce(label: string | null): void {
    this.forceOverride = label
  }

  /** Disable AI classification (use keywords only). */
  disableAI(): void {
    this.useAI = false
  }

  /** Enable AI classification. */
  enableAI(): void {
    this.useAI = true
  }

  /** Whether AI classification is active. */
  get isAIEnabled(): boolean {
    return this.useAI && !!process.env.GOOGLE_AI_API_KEY
  }

  /**
   * Route a user prompt to the best model within a mode.
   *
   * Priority:
   * 1. If /force was set, use that sub-route (or primary if 'primary')
   * 2. AI classification via Gemini 2.5 Flash Lite (if key set)
   * 3. Keyword matching fallback
   * 4. Fall back to the mode's primary model
   */
  async route(mode: ModeConfig, userPrompt: string): Promise<RouteResult> {
    // 1. Check force override
    if (this.forceOverride !== null) {
      const forced = this.forceOverride
      this.forceOverride = null

      if (forced === 'primary' || forced === mode.id) {
        return {
          model: mode.model,
          provider: mode.provider,
          subRouteLabel: null,
          reason: `Forced to primary model`,
        }
      }

      const subRoute = mode.subRoutes?.find(r => r.label === forced)
      if (subRoute) {
        return {
          model: subRoute.model,
          provider: subRoute.provider,
          subRouteLabel: subRoute.label,
          reason: `Forced to ${subRoute.label}`,
        }
      }
    }

    // Skip sub-routing if no sub-routes defined
    if (!mode.subRoutes || mode.subRoutes.length === 0) {
      return {
        model: mode.model,
        provider: mode.provider,
        subRouteLabel: null,
        reason: 'Primary model (no sub-routes)',
      }
    }

    // 2. AI classification (Gemini 2.5 Flash Lite)
    if (this.useAI) {
      const aiLabel = await aiClassify(userPrompt, mode.subRoutes, mode.description)

      if (aiLabel && aiLabel !== 'primary') {
        const subRoute = mode.subRoutes.find(r => r.label === aiLabel)
        if (subRoute) {
          return {
            model: subRoute.model,
            provider: subRoute.provider,
            subRouteLabel: subRoute.label,
            reason: `AI classified → ${subRoute.label} (${subRoute.description})`,
          }
        }
      }

      // AI said "primary" or returned a valid response
      if (aiLabel === 'primary') {
        return {
          model: mode.model,
          provider: mode.provider,
          subRouteLabel: null,
          reason: 'AI classified → primary model',
        }
      }
    }

    // 3. Keyword matching fallback
    const keywordMatch = keywordClassify(userPrompt, mode.subRoutes)
    if (keywordMatch) {
      return {
        model: keywordMatch.model,
        provider: keywordMatch.provider,
        subRouteLabel: keywordMatch.label,
        reason: `Keyword match → ${keywordMatch.label} (${keywordMatch.description})`,
      }
    }

    // 4. Fall back to primary
    return {
      model: mode.model,
      provider: mode.provider,
      subRouteLabel: null,
      reason: 'Primary model (default)',
    }
  }

  /**
   * List available sub-routes for a mode (used by /force help).
   */
  listRoutes(mode: ModeConfig): Array<{ label: string; description: string }> {
    const routes: Array<{ label: string; description: string }> = [
      { label: 'primary', description: `${mode.emoji} ${mode.name} default model` },
    ]

    if (mode.subRoutes) {
      for (const r of mode.subRoutes) {
        routes.push({ label: r.label, description: r.description })
      }
    }

    return routes
  }
}
