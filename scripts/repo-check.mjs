#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const failures = []

function run(label, executable, args) {
  console.log(`\n=== ${label} ===`)
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd'),
    env: process.env,
  })
  if (result.error || result.status !== 0) {
    failures.push(label)
    console.error(`[FAIL] ${label}`)
  }
}

function walk(directory, output = []) {
  if (!fs.existsSync(directory)) return output
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', '.next', '.aura-data', 'node_modules', 'zcash-wallet-data', 'target', '_aura_submission_staging'].includes(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(fullPath, output)
    else if (!/\.(zip|png|jpg|jpeg)$/i.test(entry.name)) output.push(fullPath)
  }
  return output
}

const forbidden = /FOUNDER INPUT REQUIRED|SUBMISSION BLOCKER|Submission blocker|placeholder founder/i
for (const file of walk(root)) {
  if (['submission-check.mjs', 'repo-check.mjs'].includes(path.basename(file))) continue
  try {
    const stat = fs.statSync(file)
    if (stat.size > 2 * 1024 * 1024) continue
    if (forbidden.test(fs.readFileSync(file, 'utf8'))) {
      failures.push(`text hygiene: ${path.relative(root, file)}`)
      console.error(`[FAIL] text hygiene: ${path.relative(root, file)}`)
    }
  } catch {
    // Binary/unreadable files are outside this text check.
  }
}

function getPackageManager() {
  const isWin = process.platform === 'win32'
  const pnpmBin = isWin ? 'pnpm.cmd' : 'pnpm'
  const probe = spawnSync(pnpmBin, ['--version'], { stdio: 'ignore', shell: isWin })
  if (!probe.error && probe.status === 0) return { bin: pnpmBin, isNpm: false }
  return { bin: isWin ? 'npm.cmd' : 'npm', isNpm: true }
}

const pm = getPackageManager()
run('Public proof artifact', process.execPath, ['scripts/verify-public-proof.mjs'])
run('Production build', pm.bin, pm.isNpm ? ['run', 'build'] : ['build'])
run('Integrity tests', pm.bin, pm.isNpm ? ['run', 'test'] : ['test'])

if (failures.length) {
  console.error(`\nREPOSITORY CHECK FAILED: ${failures.length} issue(s).`)
  process.exitCode = 1
} else {
  console.log('\nREPOSITORY CHECK PASSED: proof, build, tests, and text hygiene are clean.')
}
