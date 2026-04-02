#!/usr/bin/env node

/**
 * @fileoverview CLI entry point for the Multi-Agent Coding CLI (OMA).
 *
 * Usage:
 *   npx tsx src/cli/index.ts                    # interactive REPL
 *   npx tsx src/cli/index.ts --mode planning    # start in specific mode
 *   npx tsx src/cli/index.ts --help             # show help
 */

import { config as loadEnv } from 'dotenv'
import { Repl } from './repl.js'

// ---------------------------------------------------------------------------
// Load environment
// ---------------------------------------------------------------------------

loadEnv() // loads .env from cwd

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(): { mode?: string; help: boolean } {
  const args = process.argv.slice(2)
  let mode: string | undefined
  let help = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--mode' || arg === '-m') {
      mode = args[++i]
    }
  }

  return { mode, help }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { mode, help } = parseArgs()

  if (help) {
    console.log(`
Multi-Agent Coding CLI (OMA)
Cost-optimised AI coding assistant with specialised modes.

Usage:
  oma                         Start interactive REPL
  oma --mode <mode>           Start in a specific mode
  oma --help                  Show this help

Modes:
  planning          🧠 Architecture design with Claude Opus 4.6
  execute-backend   ⚙️ Backend code with Sonnet + DeepSeek + Qwen
  execute-frontend  🎨 Frontend code with Kimi K2.5 + Sonnet
  security-audit    🛡️ Security scanning with DeepSeek + Sonnet
  debugging         🔍 Bug diagnosis with Qwen3-30B + Sonnet + R1

Environment variables (set in .env):
  ANTHROPIC_API_KEY    Required for Planning, Backend, Security
  DEEPSEEK_API_KEY     Required for Backend sub-routing, Security sweep
  DASHSCOPE_API_KEY    Required for Debugging, Backend boilerplate
  KIMI_API_KEY         Required for Frontend mode
  GOOGLE_AI_API_KEY    Optional (Gemini 2.5 Flash for quick tasks)
`)
    process.exit(0)
  }

  // Validate at least one API key is set
  const hasAnyKey = !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.DASHSCOPE_API_KEY ||
    process.env.KIMI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY
  )

  if (!hasAnyKey) {
    console.error('\x1b[31mError: No API keys found.\x1b[0m')
    console.error('Copy .env.example to .env and fill in your API keys.')
    console.error('At minimum, set ANTHROPIC_API_KEY for Planning mode.')
    process.exit(1)
  }

  // Start the REPL
  const repl = new Repl()

  // Handle clean shutdown
  process.on('SIGINT', () => {
    console.log('\n')
    repl.close()
    process.exit(0)
  })

  await repl.start()
}

main().catch((err) => {
  console.error('\x1b[31mFatal error:\x1b[0m', err)
  process.exit(1)
})
