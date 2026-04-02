/**
 * @fileoverview Git operations tool for the multi-agent CLI.
 *
 * Provides read-only git operations used across modes:
 * - log: view commit history
 * - diff: see changes between refs
 * - blame: annotate file lines with commit info
 * - show: display a specific commit
 * - status: current working tree status
 */

import { z } from 'zod'
import { execSync } from 'node:child_process'
import type { ToolDefinition, ToolResult, ToolUseContext } from '../../types.js'

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const gitInputSchema = z.object({
  command: z.enum(['log', 'diff', 'blame', 'show', 'status', 'branch']).describe(
    'Git subcommand to execute (read-only operations only).'
  ),
  args: z.string().optional().describe(
    'Additional arguments for the git command. Examples: "--oneline -20" for log, "HEAD~3..HEAD" for diff, "src/index.ts" for blame.'
  ),
  path: z.string().optional().describe(
    'Working directory for the git command. Defaults to cwd.'
  ),
})

type GitInput = z.infer<typeof gitInputSchema>

// ---------------------------------------------------------------------------
// Safety: only allow read-only commands
// ---------------------------------------------------------------------------

const ALLOWED_COMMANDS = new Set(['log', 'diff', 'blame', 'show', 'status', 'branch'])

const BLOCKED_ARGS = [
  '--exec', '-x',
  '&&', '||', '|', ';',
  '$(', '`',
  '>', '>>', '<',
]

function validateArgs(args: string): boolean {
  const lower = args.toLowerCase()
  return !BLOCKED_ARGS.some(blocked => lower.includes(blocked))
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const gitTool: ToolDefinition<GitInput> = {
  name: 'git',
  description: 'Execute read-only git operations: log, diff, blame, show, status, branch. Use for investigating code history, changes, and commit authorship. This tool ONLY runs read-only commands — no add, commit, push, checkout, etc.',
  inputSchema: gitInputSchema,

  async execute(input: GitInput, context: ToolUseContext): Promise<ToolResult> {
    if (!ALLOWED_COMMANDS.has(input.command)) {
      return { data: `Error: "${input.command}" is not an allowed git command. Only read-only operations: ${[...ALLOWED_COMMANDS].join(', ')}`, isError: true }
    }

    const args = input.args ?? ''
    if (args && !validateArgs(args)) {
      return { data: 'Error: Arguments contain potentially unsafe characters. Shell operators, exec flags, and redirects are not allowed.', isError: true }
    }

    const cwd = input.path ?? context.cwd ?? process.cwd()

    // Build the command with sensible defaults
    let cmd: string
    switch (input.command) {
      case 'log':
        cmd = `git log ${args || '--oneline -20'}`
        break
      case 'diff':
        cmd = `git diff ${args || 'HEAD'}`
        break
      case 'blame':
        if (!args) {
          return { data: 'Error: "blame" requires a file path in args.', isError: true }
        }
        cmd = `git blame ${args}`
        break
      case 'show':
        cmd = `git show ${args || 'HEAD'}`
        break
      case 'status':
        cmd = `git status ${args || '--short'}`
        break
      case 'branch':
        cmd = `git branch ${args || '-a --list'}`
        break
      default:
        return { data: `Error: Unknown command "${input.command}"`, isError: true }
    }

    try {
      const output = execSync(cmd, {
        cwd,
        timeout: 15000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB max output
      })

      // Truncate very long output
      const maxLen = 10_000
      if (output.length > maxLen) {
        return { data: output.slice(0, maxLen) + `\n\n... (truncated, ${output.length - maxLen} more characters)` }
      }

      return { data: output || '(no output)' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Clean up common git errors
      if (message.includes('not a git repository')) {
        return { data: 'Error: Not a git repository. Make sure you are in a git-initialized directory.', isError: true }
      }
      return { data: `Git error: ${message.slice(0, 500)}`, isError: true }
    }
  },
}
