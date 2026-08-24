#!/usr/bin/env node
/**
 * Build-time enforcement of invariant I-1 (see CLAUDE.md, docs/architecture.md §5.3).
 *
 * WHAT THIS PROTECTS
 * ------------------
 * pledge's entire product claim is that nothing self-reported is ever authoritative. There is
 * no "mark as done" endpoint. `kept` and `missed` are written ONLY by the probe worker; the
 * witness handler may reach `disputed` and nothing else.
 *
 * Postgres grants cannot enforce this — architecture.md §5.3 says so plainly: a CHECK
 * constraint "can't tell *who* set the status", and pledge_web holds table-level UPDATE on
 * `commitment` because it legitimately needs to write amendments and visibility. So the real
 * enforcement is this check. It is not a lint rule. Its failure means the product's core claim
 * is false, which is why it fails the build rather than warning.
 *
 * WHAT IT LOOKS FOR
 * -----------------
 * Assignments of a resolution status to a `status` field inside apps/web — not bare
 * occurrences of the words. The profile page legitimately RENDERS the string "kept" as a badge
 * label, and a check that flagged that would be turned off within a week, which is the failure
 * mode this file exists to avoid.
 *
 * There is deliberately no escape hatch. If you need one, you have misunderstood the product.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const GUARDED_DIR = join(ROOT, 'apps/web')
const RESOLUTION_STATUSES = ['kept', 'missed']

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.turbo'])
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const TEST_FILE = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|\/__tests__\//

/**
 * Assignment shapes that would write a resolution status:
 *   status: 'kept'            object literal / drizzle .set({...}) / insert values
 *   status = 'kept'           direct assignment
 *   status: "missed"          double quotes
 *   status: `kept`            template literal with no interpolation
 * The `status` key may be prefixed (commitment.status, c.status, newStatus is NOT matched —
 * only an exact `status` identifier, to keep the rule legible).
 */
const buildPattern = (value) =>
  new RegExp(
    String.raw`(?:^|[^A-Za-z0-9_])status\s*[:=]\s*(['"\`])${value}\1`,
    'g',
  )

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (CODE_EXT.test(full)) yield full
  }
}

const violations = []

for (const file of walk(GUARDED_DIR)) {
  const rel = relative(ROOT, file)
  if (TEST_FILE.test(rel)) continue

  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')

  for (const value of RESOLUTION_STATUSES) {
    const pattern = buildPattern(value)
    let match
    while ((match = pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length
      violations.push({ file: rel, line, value, text: lines[line - 1].trim() })
    }
  }
}

if (violations.length > 0) {
  console.error('\n  INVARIANT I-1 VIOLATED — apps/web writes a resolution status.\n')
  console.error('  Resolution is written only by the probe worker. There is no')
  console.error('  mark-as-done endpoint. See CLAUDE.md and docs/architecture.md §5.3.\n')
  for (const v of violations) {
    console.error(`    ${v.file}:${v.line}  →  ${v.text}`)
  }
  console.error('\n  Remove the write. Do not weaken this check.\n')
  process.exit(1)
}

console.log(`invariant I-1 ok — no resolution status written in apps/web`)
