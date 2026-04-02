/**
 * @fileoverview Terminal display utilities for the multi-agent CLI.
 *
 * Provides coloured output, mode banners, streaming text rendering,
 * tool-call indicators, and a simple spinner for long operations.
 */

// ---------------------------------------------------------------------------
// ANSI colour helpers
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const ITALIC = '\x1b[3m'
const CYAN = '\x1b[36m'
const GRAY = '\x1b[90m'
const WHITE = '\x1b[37m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'

// ---------------------------------------------------------------------------
// Display class
// ---------------------------------------------------------------------------

export class Display {
  /** Print the mode selection menu. */
  showModeMenu(modes: Array<{ id: string; emoji: string; name: string; description: string; color: string }>, currentMode?: string): void {
    console.log(`\n${BOLD}Select a mode:${RESET}`)
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i]!
      const marker = m.id === currentMode ? ` ${GREEN}◀ current${RESET}` : ''
      console.log(`  ${DIM}${i + 1}.${RESET} ${m.color}${m.emoji} ${m.name}${RESET} — ${GRAY}${m.description}${RESET}${marker}`)
    }
    console.log()
  }

  /** Print the welcome banner. */
  showBanner(): void {
    console.log(`
${BOLD}${CYAN}╔══════════════════════════════════════════╗
║       Multi-Agent Coding CLI (OMA)       ║
║   Cost-optimised AI coding assistant     ║
╚══════════════════════════════════════════╝${RESET}

${DIM}Commands: /mode  /cost  /force  /router  /clear  /help  /quit${RESET}
`)
  }

  /** Show the active mode indicator. */
  showActiveMode(emoji: string, name: string, model: string, color: string): void {
    console.log(`${color}${BOLD}${emoji} ${name}${RESET} ${DIM}(${model})${RESET}`)
  }

  /** Print a section divider. */
  divider(): void {
    console.log(`${DIM}${'─'.repeat(50)}${RESET}`)
  }

  /** Print streamed text delta (no newline). */
  streamText(text: string): void {
    process.stdout.write(text)
  }

  /** End a streaming block. */
  streamEnd(): void {
    console.log()
  }

  /** Show a tool call being initiated. */
  showToolCall(toolName: string, input: Record<string, unknown>): void {
    const summary = Object.entries(input)
      .map(([k, v]) => {
        const val = typeof v === 'string' ? (v.length > 60 ? v.slice(0, 57) + '...' : v) : JSON.stringify(v)
        return `${k}=${val}`
      })
      .join(', ')
    console.log(`  ${YELLOW}⚡ ${toolName}${RESET}${summary ? ` ${DIM}${summary}${RESET}` : ''}`)
  }

  /** Show tool result. */
  showToolResult(toolName: string, isError: boolean): void {
    if (isError) {
      console.log(`  ${RED}✗ ${toolName} failed${RESET}`)
    } else {
      console.log(`  ${GREEN}✓ ${toolName}${RESET}`)
    }
  }

  /** Show a cost line after a response. */
  showCost(summary: string): void {
    console.log(`${DIM}  💰 ${summary}${RESET}`)
  }

  /** Print an error message. */
  error(message: string): void {
    console.error(`${RED}${BOLD}Error:${RESET} ${RED}${message}${RESET}`)
  }

  /** Print an info message. */
  info(message: string): void {
    console.log(`${CYAN}${message}${RESET}`)
  }

  /** Print a warning. */
  warn(message: string): void {
    console.log(`${YELLOW}${message}${RESET}`)
  }

  /** Print a success message. */
  success(message: string): void {
    console.log(`${GREEN}${message}${RESET}`)
  }

  /** Show help message. */
  showHelp(): void {
    console.log(`
${BOLD}Available Commands:${RESET}
  ${CYAN}/mode${RESET}              Switch to a different mode
  ${CYAN}/mode <name>${RESET}       Switch directly (e.g. /mode planning)
  ${CYAN}/cost${RESET}              Show session cost summary
  ${CYAN}/clear${RESET}             Reset conversation history
  ${CYAN}/force <model>${RESET}     Override model for next message (e.g. /force deepseek)
  ${CYAN}/router${RESET}            Show/toggle AI classifier (Gemini Flash Lite)
  ${CYAN}/router on|off${RESET}     Enable/disable AI-based sub-routing
  ${CYAN}/help${RESET}              Show this help
  ${CYAN}/quit${RESET}              Exit the CLI

${BOLD}Modes:${RESET}
  🧠 planning         Claude Opus 4.6 — architecture, spec.md generation
  ⚙️ execute-backend   Claude Sonnet 4.6 — server code, APIs, tests
  🎨 execute-frontend  Kimi K2.5 — visual components, CSS, responsive design
  🛡️ security-audit    Sonnet + DeepSeek — two-pass vulnerability scanning
  🔍 debugging         Qwen3-30B — fast bug diagnosis, root-cause analysis
`)
  }
}
