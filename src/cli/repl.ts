/**
 * @fileoverview Interactive REPL for the multi-agent CLI.
 *
 * Handles the main user interaction loop: mode selection, message input,
 * agent invocation, streaming output, and slash command processing.
 */

import * as readline from 'node:readline'
import type { StreamEvent, LLMMessage, ContentBlock } from '../types.js'
import { createAdapter } from '../llm/adapter.js'
import { AgentRunner, type RunnerOptions } from '../agent/runner.js'
import { ToolRegistry } from '../tool/framework.js'
import { ToolExecutor } from '../tool/executor.js'
import { registerBuiltInTools } from '../tool/built-in/index.js'
import { MODES, MODE_ORDER, getMode, type ModeConfig } from './mode-config.js'
import { ModelRouter } from './router.js'
import { CostTracker } from './cost-tracker.js'
import { Display } from './display.js'
import { PLANNING_SYSTEM_PROMPT } from './prompts/planning.js'
import { BACKEND_SYSTEM_PROMPT, BACKEND_DEEPSEEK_PROMPT, BACKEND_QWEN_PROMPT } from './prompts/execute-backend.js'
import { FRONTEND_SYSTEM_PROMPT, FRONTEND_SONNET_PROMPT } from './prompts/execute-frontend.js'
import { SECURITY_SYSTEM_PROMPT, SECURITY_SWEEP_PROMPT } from './prompts/security-audit.js'
import { DEBUGGING_SYSTEM_PROMPT, DEBUGGING_SONNET_PROMPT, DEBUGGING_R1_PROMPT } from './prompts/debugging.js'

// ---------------------------------------------------------------------------
// Prompt resolution — maps (modeId, subRouteLabel) to the right system prompt
// ---------------------------------------------------------------------------

function resolveSystemPrompt(modeId: string, subRouteLabel: string | null): string {
  switch (modeId) {
    case 'planning':
      return PLANNING_SYSTEM_PROMPT

    case 'execute-backend':
      if (subRouteLabel === 'deepseek') return BACKEND_DEEPSEEK_PROMPT
      if (subRouteLabel === 'qwen') return BACKEND_QWEN_PROMPT
      return BACKEND_SYSTEM_PROMPT

    case 'execute-frontend':
      if (subRouteLabel === 'sonnet') return FRONTEND_SONNET_PROMPT
      return FRONTEND_SYSTEM_PROMPT

    case 'security-audit':
      if (subRouteLabel === 'deepseek-sweep') return SECURITY_SWEEP_PROMPT
      return SECURITY_SYSTEM_PROMPT

    case 'debugging':
      if (subRouteLabel === 'sonnet') return DEBUGGING_SONNET_PROMPT
      if (subRouteLabel === 'deepseek-r1') return DEBUGGING_R1_PROMPT
      return DEBUGGING_SYSTEM_PROMPT

    default:
      return `You are an AI coding assistant. Be concise and technical.`
  }
}

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

export class Repl {
  private rl: readline.Interface
  private display = new Display()
  private costTracker = new CostTracker()
  private router = new ModelRouter()
  private currentModeId: string = 'planning'
  private conversationHistory: LLMMessage[] = []
  private toolRegistry: ToolRegistry
  private toolExecutor: ToolExecutor

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    // Register built-in tools
    this.toolRegistry = new ToolRegistry()
    this.toolExecutor = new ToolExecutor(this.toolRegistry, { maxConcurrency: 5 })
    registerBuiltInTools(this.toolRegistry)
  }

  /** Start the interactive session. */
  async start(): Promise<void> {
    this.display.showBanner()

    // Initial mode selection
    await this.selectMode()

    // Main loop
    this.promptUser()
  }

  /** Show mode menu and let user pick. */
  private async selectMode(): Promise<void> {
    const modes = MODE_ORDER.map(id => {
      const m = getMode(id)
      return { id: m.id, emoji: m.emoji, name: m.name, description: m.description, color: m.color }
    })

    this.display.showModeMenu(modes, this.currentModeId)

    return new Promise((resolve) => {
      this.rl.question('  Enter mode number (1-5): ', (answer) => {
        const num = parseInt(answer.trim(), 10)
        if (num >= 1 && num <= MODE_ORDER.length) {
          this.currentModeId = MODE_ORDER[num - 1]!
          const mode = getMode(this.currentModeId)
          this.display.success(`\n  Switched to ${mode.emoji} ${mode.name}`)
          this.conversationHistory = [] // reset history on mode switch
        } else {
          this.display.warn('  Invalid selection, keeping current mode.')
        }
        resolve()
      })
    })
  }

  /** Main prompt loop. */
  private promptUser(): void {
    const mode = getMode(this.currentModeId)
    this.rl.question(`\n${mode.color}${mode.emoji} ${mode.name}${'\x1b[0m'} > `, async (input) => {
      const trimmed = input.trim()

      if (!trimmed) {
        this.promptUser()
        return
      }

      // Handle slash commands
      if (trimmed.startsWith('/')) {
        await this.handleSlashCommand(trimmed)
        this.promptUser()
        return
      }

      // Process message through the agent
      await this.processMessage(trimmed)
      this.promptUser()
    })
  }

  /** Handle slash commands. */
  private async handleSlashCommand(command: string): Promise<void> {
    const parts = command.split(/\s+/)
    const cmd = parts[0]!.toLowerCase()
    const args = parts.slice(1)

    switch (cmd) {
      case '/quit':
      case '/exit':
        console.log()
        this.display.divider()
        console.log(this.costTracker.sessionSummary())
        this.display.divider()
        console.log()
        process.exit(0)
        break

      case '/mode':
        if (args.length > 0) {
          const modeId = args[0]!
          if (MODES.has(modeId)) {
            this.currentModeId = modeId
            const mode = getMode(modeId)
            this.display.success(`Switched to ${mode.emoji} ${mode.name}`)
            this.conversationHistory = []
          } else {
            this.display.error(`Unknown mode: ${modeId}. Available: ${MODE_ORDER.join(', ')}`)
          }
        } else {
          await this.selectMode()
        }
        break

      case '/cost':
        this.display.divider()
        console.log(this.costTracker.sessionSummary())
        this.display.divider()
        break

      case '/clear':
        this.conversationHistory = []
        this.display.info('Conversation history cleared.')
        break

      case '/force':
        if (args.length > 0) {
          const label = args[0]!.toLowerCase()
          const mode = getMode(this.currentModeId)
          const available = this.router.listRoutes(mode)
          const match = available.find(r => r.label === label)
          if (match) {
            this.router.setForce(label)
            this.display.info(`Next message will use: ${label} (${match.description})`)
          } else {
            this.display.error(`Unknown route "${label}". Available for ${mode.name}:`)
            for (const r of available) {
              console.log(`  ${r.label} — ${r.description}`)
            }
          }
        } else {
          const mode = getMode(this.currentModeId)
          const routes = this.router.listRoutes(mode)
          this.display.info(`Available routes for ${mode.emoji} ${mode.name}:`)
          for (const r of routes) {
            console.log(`  /force ${r.label} — ${r.description}`)
          }
        }
        break

      case '/help':
        this.display.showHelp()
        break

      case '/router':
        if (args[0] === 'off') {
          this.router.disableAI()
          this.display.info('AI classification disabled. Using keyword matching only.')
        } else if (args[0] === 'on') {
          this.router.enableAI()
          if (this.router.isAIEnabled) {
            this.display.success('AI classification enabled (Gemini 2.5 Flash Lite).')
          } else {
            this.display.warn('AI classification enabled but GOOGLE_AI_API_KEY not set. Using keywords.')
          }
        } else {
          this.display.info(`AI router: ${this.router.isAIEnabled ? '✅ ON (Gemini Flash Lite)' : '❌ OFF (keywords only)'}`)
          this.display.info('  /router on   — enable AI classification')
          this.display.info('  /router off  — disable AI classification (keywords only)')
        }
        break

      default:
        this.display.warn(`Unknown command: ${cmd}. Type /help for available commands.`)
    }
  }

  /** Process a user message through the current mode's agent. */
  private async processMessage(userPrompt: string): Promise<void> {
    const mode = getMode(this.currentModeId)
    const routeResult = await this.router.route(mode, userPrompt)

    // Show routing decision
    const modelDisplay = this.costTracker.getModelName(routeResult.model)
    this.display.showActiveMode(mode.emoji, mode.name, modelDisplay, mode.color)
    if (routeResult.subRouteLabel) {
      this.display.info(`  ↳ Sub-route: ${routeResult.reason}`)
    }
    this.display.divider()

    try {
      // Get the appropriate system prompt for this mode + sub-route
      const systemPrompt = resolveSystemPrompt(mode.id, routeResult.subRouteLabel)

      // Create adapter for the routed model
      const adapter = await createAdapter(routeResult.provider)

      const runnerOptions: RunnerOptions = {
        model: routeResult.model,
        systemPrompt,
        maxTurns: mode.maxTurns,
        maxTokens: mode.maxTokens,
        temperature: mode.temperature,
        allowedTools: mode.tools as string[],
        agentName: mode.id,
        agentRole: mode.name,
      }

      const runner = new AgentRunner(
        adapter,
        this.toolRegistry,
        this.toolExecutor,
        runnerOptions,
      )

      // Build messages array
      const userMessage: LLMMessage = {
        role: 'user',
        content: [{ type: 'text', text: userPrompt }],
      }
      this.conversationHistory.push(userMessage)

      // Stream the response
      let fullOutput = ''
      const assistantBlocks: ContentBlock[] = []
      let lastUsage = { input_tokens: 0, output_tokens: 0 }

      for await (const event of runner.stream([...this.conversationHistory])) {
        switch (event.type) {
          case 'text': {
            const text = event.data as string
            this.display.streamText(text)
            fullOutput += text
            break
          }
          case 'tool_use': {
            const toolCall = event.data as { name: string; input: Record<string, unknown> }
            this.display.streamEnd()
            this.display.showToolCall(toolCall.name, toolCall.input)
            break
          }
          case 'tool_result': {
            const result = event.data as { tool_use_id: string; is_error?: boolean }
            this.display.showToolResult('tool', result.is_error ?? false)
            break
          }
          case 'done': {
            const response = event.data as { usage: { input_tokens: number; output_tokens: number }; content: ContentBlock[] }
            lastUsage = response.usage
            assistantBlocks.push(...response.content)
            break
          }
          case 'error': {
            const err = event.data as Error
            this.display.error(err.message)
            break
          }
        }
      }

      this.display.streamEnd()

      // Record cost
      this.costTracker.record(routeResult.model, lastUsage)
      this.display.showCost(this.costTracker.lastEntrySummary())

      // Save assistant response to history
      if (assistantBlocks.length > 0) {
        this.conversationHistory.push({
          role: 'assistant',
          content: assistantBlocks,
        })
      } else if (fullOutput) {
        this.conversationHistory.push({
          role: 'assistant',
          content: [{ type: 'text', text: fullOutput }],
        })
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.display.error(`Agent execution failed: ${errorMessage}`)

      // Check for common issues
      if (errorMessage.includes('API key') || errorMessage.includes('auth')) {
        this.display.warn('Hint: Check your .env file or environment variables.')
      }
      if (errorMessage.includes('model')) {
        this.display.warn(`Hint: The model "${routeResult.model}" may not be available for your account.`)
      }
    }
  }

  /** Cleanup on exit. */
  close(): void {
    this.rl.close()
  }
}
