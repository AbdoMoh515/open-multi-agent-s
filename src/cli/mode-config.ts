/**
 * @fileoverview Mode configuration and model assignments.
 *
 * Defines the five agent modes, their model bindings, tool sets,
 * and sub-routing rules. Derived from the user's research document
 * (AI Coding API Comparison and Selection).
 */

import type { SupportedProvider } from '../llm/adapter.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A secondary model that can be routed to within a mode. */
export interface SubRoute {
  /** Human-readable label for this sub-route. */
  readonly label: string
  /** Model identifier (e.g. 'deepseek-chat'). */
  readonly model: string
  /** Which LLM provider hosts this model. */
  readonly provider: SupportedProvider
  /** Keywords that trigger auto-routing to this sub-route. */
  readonly keywords: readonly string[]
  /** Description shown when listing sub-routes. */
  readonly description: string
}

/** Full configuration for a single CLI mode. */
export interface ModeConfig {
  /** Internal identifier (used in CLI args and routing). */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Emoji prefix for terminal output. */
  readonly emoji: string
  /** One-line description of the mode. */
  readonly description: string
  /** Primary model identifier. */
  readonly model: string
  /** Provider for the primary model. */
  readonly provider: SupportedProvider
  /** System prompt for this mode's primary agent. */
  readonly systemPromptModule: string
  /** Names of tools available to this agent (from the ToolRegistry). */
  readonly tools: readonly string[]
  /** Max output tokens per turn. */
  readonly maxTokens: number
  /** LLM temperature setting. */
  readonly temperature: number
  /** Max agentic turns (LLM → tool → LLM cycles). */
  readonly maxTurns: number
  /** Available sub-routes for hybrid routing within this mode. */
  readonly subRoutes?: readonly SubRoute[]
  /** ANSI colour code for terminal output decorations. */
  readonly color: string
}

// ---------------------------------------------------------------------------
// Mode definitions
// ---------------------------------------------------------------------------

/**
 * Mode 1: Planning — Claude Opus 4.6
 *
 * "Claude Opus 4.6 is the undisputed leader in multi-file architectural
 *  reasoning. Its 1M context window ensures modifications in a database
 *  access layer are correctly anticipated in service/presentation layers."
 */
const PLANNING: ModeConfig = {
  id: 'planning',
  name: 'Planning',
  emoji: '🧠',
  description: 'Architecture design, task decomposition, spec.md generation',
  model: 'claude-opus-4-20250918',
  provider: 'anthropic',
  systemPromptModule: './prompts/planning.js',
  tools: ['file_read', 'grep', 'bash', 'git'],
  maxTokens: 8192,
  temperature: 0.3,
  maxTurns: 20,
  color: '\x1b[34m', // blue
}

/**
 * Mode 2: Execute Backend — Claude Sonnet 4.6 + DeepSeek V4 + Qwen
 *
 * "Claude Sonnet 4.6 acts as The Workhorse of backend logic...
 *  consistently scoring above 71% on SWE-bench."
 * "GPT-5/DeepSeek uses significantly fewer tokens to achieve the same
 *  algorithmic outcome." (DeepSeek V4 replaces GPT-5.4 since no OpenAI key)
 * "Qwen drives blended cost down by 87% for boilerplate."
 */
const EXECUTE_BACKEND: ModeConfig = {
  id: 'execute-backend',
  name: 'Execute Backend',
  emoji: '⚙️',
  description: 'Server-side code, APIs, databases, business logic, tests',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  systemPromptModule: './prompts/execute-backend.js',
  tools: ['bash', 'file_read', 'file_write', 'file_edit', 'grep'],
  maxTokens: 16384,
  temperature: 0.1,
  maxTurns: 40,
  subRoutes: [
    {
      label: 'deepseek',
      model: 'deepseek-chat',
      provider: 'deepseek',
      keywords: ['function', 'transform', 'convert', 'parse', 'serialize', 'utility', 'helper', 'single file'],
      description: 'Single-file functions & data transforms (token-efficient)',
    },
    {
      label: 'qwen',
      model: 'qwen2.5-coder-32b-instruct',
      provider: 'qwen',
      keywords: ['crud', 'scaffold', 'boilerplate', 'template', 'migration', 'generate', 'repetitive'],
      description: 'Boilerplate CRUD, scaffolding (87% cheaper)',
    },
  ],
  color: '\x1b[32m', // green
}

/**
 * Mode 3: Execute Frontend — Kimi K2.5 + Claude Sonnet
 *
 * "Kimi K2.5 provides unmatched visual-to-code fidelity...
 *  pretrained on 15 trillion mixed visual and text tokens."
 */
const EXECUTE_FRONTEND: ModeConfig = {
  id: 'execute-frontend',
  name: 'Execute Frontend',
  emoji: '🎨',
  description: 'UI components, styling, responsive layouts, animations',
  model: 'kimi-k2.5',
  provider: 'kimi',
  systemPromptModule: './prompts/execute-frontend.js',
  tools: ['bash', 'file_read', 'file_write', 'file_edit', 'grep'],
  maxTokens: 16384,
  temperature: 0.2,
  maxTurns: 40,
  subRoutes: [
    {
      label: 'sonnet',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      keywords: ['state', 'hook', 'context', 'redux', 'store', 'logic', 'api call', 'fetch', 'auth', 'routing'],
      description: 'Complex UI logic, state management, data binding',
    },
  ],
  color: '\x1b[35m', // magenta
}

/**
 * Mode 4: Security Audit — DeepSeek V4 (sweep) + Claude Sonnet (deep)
 *
 * "Anthropic has heavily prioritized defensive alignment; Claude 4 models
 *  exhibit pronounced refusal behavior when prompted with unsafe completions."
 */
const SECURITY_AUDIT: ModeConfig = {
  id: 'security-audit',
  name: 'Security Audit',
  emoji: '🛡️',
  description: 'Vulnerability scanning, code review, dependency auditing',
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  systemPromptModule: './prompts/security-audit.js',
  tools: ['file_read', 'grep', 'bash', 'security_scan', 'git'],
  maxTokens: 8192,
  temperature: 0.0,
  maxTurns: 30,
  // Pre-scan sub-route for the broad sweep pass
  subRoutes: [
    {
      label: 'deepseek-sweep',
      model: 'deepseek-chat',
      provider: 'deepseek',
      keywords: ['scan', 'sweep', 'quick', 'broad'],
      description: 'Initial broad sweep — secrets, obvious vulns, deps',
    },
  ],
  color: '\x1b[31m', // red
}

/**
 * Mode 5: Debugging — Qwen3-30B + Claude Sonnet + DeepSeek R1
 *
 * "Qwen3-30B MoE is exceptionally performant for localized debugging...
 *  near-instantaneous inference."
 */
const DEBUGGING: ModeConfig = {
  id: 'debugging',
  name: 'Debugging',
  emoji: '🔍',
  description: 'Diagnose bugs, trace errors, analyse stack traces, propose fixes',
  model: 'qwen3-30b-a3b',
  provider: 'qwen',
  systemPromptModule: './prompts/debugging.js',
  tools: ['bash', 'file_read', 'grep', 'file_edit', 'git'],
  maxTokens: 8192,
  temperature: 0.1,
  maxTurns: 30,
  subRoutes: [
    {
      label: 'sonnet',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      keywords: ['refactor', 'review', 'pr review', 'pull request', 'architecture', 'regression', 'cross-file', 'multi-file'],
      description: 'Macro-level refactoring, PR reviews, cross-file regressions',
    },
    {
      label: 'deepseek-r1',
      model: 'deepseek-reasoner',
      provider: 'deepseek',
      keywords: ['algorithm', 'performance', 'optimize', 'complexity', 'math', 'race condition', 'concurrency', 'deadlock'],
      description: 'Complex algorithmic debugging with transparent chain-of-thought',
    },
  ],
  color: '\x1b[33m', // yellow
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All available modes, indexed by ID. */
export const MODES: ReadonlyMap<string, ModeConfig> = new Map([
  ['planning', PLANNING],
  ['execute-backend', EXECUTE_BACKEND],
  ['execute-frontend', EXECUTE_FRONTEND],
  ['security-audit', SECURITY_AUDIT],
  ['debugging', DEBUGGING],
])

/** Ordered list of modes for the selector menu. */
export const MODE_ORDER: readonly string[] = [
  'planning',
  'execute-backend',
  'execute-frontend',
  'security-audit',
  'debugging',
]

/** Get a mode config by ID. Throws if not found. */
export function getMode(id: string): ModeConfig {
  const mode = MODES.get(id)
  if (!mode) throw new Error(`Unknown mode: ${id}`)
  return mode
}
