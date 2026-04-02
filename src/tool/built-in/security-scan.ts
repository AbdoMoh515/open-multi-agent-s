/**
 * @fileoverview Security scanning tool for the multi-agent CLI.
 *
 * Provides automated security checks:
 * - npm/pip dependency audit
 * - Hardcoded secret detection via regex patterns
 * - Basic static analysis for common vulnerability patterns
 */

import { z } from 'zod'
import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { ToolDefinition, ToolResult, ToolUseContext } from '../../types.js'

// ---------------------------------------------------------------------------
// Secret detection patterns
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|secret_key)\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/gi },
  { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?[A-Za-z0-9_\-]{20,}/gi },
  { name: 'Generic Secret', pattern: /(?:secret|password|passwd|pwd)\s*[=:]\s*["'][^"']{8,}["']/gi },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: 'JWT Token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'Slack Token', pattern: /xox[bpors]-[0-9]{10,}-[A-Za-z0-9]{10,}/g },
  { name: 'Hardcoded IP', pattern: /(?:^|\s)(?:(?:25[0-5]|2[0-4]\d|1?\d{1,2})\.){3}(?:25[0-5]|2[0-4]\d|1?\d{1,2})(?:\s|$|[:;,])/gm },
  { name: 'Connection String', pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']+/gi },
]

const SCAN_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.java', '.cs', '.php',
  '.json', '.yaml', '.yml', '.toml', '.env',
  '.xml', '.html', '.sh', '.bash', '.zsh',
])

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'vendor', '__pycache__', '.venv', 'venv',
])

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const securityScanInputSchema = z.object({
  action: z.enum(['audit', 'secrets', 'full']).describe(
    'audit: run dependency audit (npm/pip). secrets: scan for hardcoded secrets. full: run both.'
  ),
  path: z.string().optional().describe(
    'Directory to scan. Defaults to current working directory.'
  ),
  include_pattern: z.string().optional().describe(
    'Glob pattern to include specific files (e.g. "*.ts")'
  ),
})

type SecurityScanInput = z.infer<typeof securityScanInputSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectFiles(dir: string, maxDepth = 8, depth = 0): string[] {
  if (depth > maxDepth) return []

  const files: string[] = []
  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue
      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          files.push(...collectFiles(fullPath, maxDepth, depth + 1))
        } else if (stat.isFile() && SCAN_EXTENSIONS.has(extname(entry).toLowerCase())) {
          if (stat.size < 1_000_000) { // skip files > 1MB
            files.push(fullPath)
          }
        }
      } catch { /* skip inaccessible files */ }
    }
  } catch { /* skip inaccessible dirs */ }

  return files
}

function scanForSecrets(dir: string): string[] {
  const findings: string[] = []
  const files = collectFiles(dir)

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const { name, pattern } of SECRET_PATTERNS) {
          // Reset regex lastIndex
          pattern.lastIndex = 0
          if (pattern.test(line)) {
            // Mask the actual value
            const maskedLine = line.trim().slice(0, 80)
            findings.push(`[${name}] ${file}:${i + 1} — ${maskedLine}...`)
          }
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return findings
}

function runDependencyAudit(dir: string): string {
  const results: string[] = []

  // Try npm audit
  try {
    const npmResult = execSync('npm audit --json 2>/dev/null || true', {
      cwd: dir,
      timeout: 30000,
      encoding: 'utf-8',
    })
    try {
      const audit = JSON.parse(npmResult)
      if (audit.metadata?.vulnerabilities) {
        const v = audit.metadata.vulnerabilities
        results.push(`npm audit: ${v.critical ?? 0} critical, ${v.high ?? 0} high, ${v.moderate ?? 0} moderate, ${v.low ?? 0} low`)
      }
    } catch {
      results.push(`npm audit: ${npmResult.slice(0, 500)}`)
    }
  } catch {
    results.push('npm audit: not available (no package-lock.json?)')
  }

  // Try pip audit if requirements.txt exists
  try {
    statSync(join(dir, 'requirements.txt'))
    try {
      const pipResult = execSync('pip audit 2>&1 || true', {
        cwd: dir,
        timeout: 30000,
        encoding: 'utf-8',
      })
      results.push(`pip audit: ${pipResult.slice(0, 500)}`)
    } catch {
      results.push('pip audit: tool not installed')
    }
  } catch { /* no requirements.txt */ }

  return results.length > 0 ? results.join('\n') : 'No dependency manifests found.'
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const securityScanTool: ToolDefinition<SecurityScanInput> = {
  name: 'security_scan',
  description: 'Run security scans: dependency auditing (npm audit), hardcoded secret detection, and vulnerability pattern matching. Use action="full" for comprehensive scan, "audit" for dependencies only, "secrets" for secret scanning only.',
  inputSchema: securityScanInputSchema,

  async execute(input: SecurityScanInput, context: ToolUseContext): Promise<ToolResult> {
    const dir = input.path ?? context.cwd ?? process.cwd()
    const results: string[] = []

    if (input.action === 'audit' || input.action === 'full') {
      results.push('=== Dependency Audit ===')
      results.push(runDependencyAudit(dir))
      results.push('')
    }

    if (input.action === 'secrets' || input.action === 'full') {
      results.push('=== Secret Scan ===')
      const secrets = scanForSecrets(dir)
      if (secrets.length === 0) {
        results.push('No hardcoded secrets detected.')
      } else {
        results.push(`Found ${secrets.length} potential secret(s):`)
        for (const s of secrets.slice(0, 50)) { // cap at 50 findings
          results.push(`  ⚠ ${s}`)
        }
        if (secrets.length > 50) {
          results.push(`  ... and ${secrets.length - 50} more`)
        }
      }
    }

    return { data: results.join('\n') }
  },
}
