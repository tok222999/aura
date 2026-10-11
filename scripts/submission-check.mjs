#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const failures = []

function fail(message) {
  failures.push(message)
  console.error(`[FAIL] ${message}`)
}

function run(label, executable, args) {
  console.log(`\n=== ${label} ===`)
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd'),
    env: process.env,
  })
  if (result.error || result.status !== 0) {
    fail(`${label} did not pass${result.error ? `: ${result.error.message}` : ''}`)
    return false
  }
  return true
}

function walk(directory, output = []) {
  if (!fs.existsSync(directory)) return output
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', '.next', '.aura-data', 'node_modules', 'zcash-wallet-data', 'target', '_aura_submission_staging'].includes(entry.name)) continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(fullPath, output)
    else if (!entry.name.endsWith('.zip') && !entry.name.endsWith('.png') && !entry.name.endsWith('.jpg')) output.push(fullPath)
  }
  return output
}

function checkTextHygiene() {
  const forbidden = /FOUNDER INPUT REQUIRED|SUBMISSION BLOCKER|Submission blocker|placeholder founder/i
  const contradiction = /WORKING DEMO[\s\S]{0,180}\b(?:not working|does not work|broken)\b|\b(?:not working|does not work|broken)\b[\s\S]{0,180}WORKING DEMO/i
  for (const file of walk(root)) {
    if (['submission-check.mjs', 'repo-check.mjs'].includes(path.basename(file))) continue
    let text
    try {
      const stat = fs.statSync(file)
      if (stat.size > 2 * 1024 * 1024) continue
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (forbidden.test(text)) fail(`founder placeholder remains in ${path.relative(root, file)}`)
    if (contradiction.test(text)) fail(`contradictory WORKING DEMO wording in ${path.relative(root, file)}`)
  }
}

function getPowerShell() {
  for (const candidate of process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { cwd: root, stdio: 'ignore' })
    if (!probe.error && probe.status === 0) return candidate
  }
  return null
}

function checkArchive(powerShell) {
  const zipPath = path.join(root, 'aura-submission-safe.zip')
  if (!fs.existsSync(zipPath)) {
    fail('aura-submission-safe.zip was not created')
    return
  }
  const command = `
    Add-Type -AssemblyName System.IO.Compression;
    $z = [IO.Compression.ZipFile]::OpenRead($env:AURA_SUBMISSION_ZIP);
    try {
      $bad = @($z.Entries | Where-Object { $_.FullName -match '(^|/)(\\.env(\\.local)?|\\.aura-data|zcash-wallet-data|node_modules|\\.next|target)(/|$)' -or $_.FullName -match '\\.(pem|key|p12|pfx)$' });
      if ($bad.Count -gt 0) { $bad | ForEach-Object { Write-Output $_.FullName }; exit 1 }
      if (-not ($z.Entries | Where-Object FullName -eq 'README.md')) { exit 2 }
      if (-not ($z.Entries | Where-Object FullName -like 'tests/*')) { exit 3 }
      if (-not ($z.Entries | Where-Object FullName -eq 'FINAL_SUBMISSION_COPY.md')) { exit 4 }
      if (-not ($z.Entries | Where-Object FullName -eq 'FINAL_JURY_QA.md')) { exit 5 }
    } finally { $z.Dispose() }
  `
  const result = spawnSync(powerShell, ['-NoProfile', '-Command', command], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, AURA_SUBMISSION_ZIP: zipPath },
  })
  if (result.error || result.status !== 0) fail('safe ZIP contains forbidden runtime/secret files or is incomplete')
}

console.log('AURA SUBMISSION RELEASE GATE')
checkTextHygiene()
run('Runtime configuration (strict)', 'node', ['scripts/verify-runtime-config.mjs', '--strict'])
run('Public proof artifact', 'node', ['scripts/verify-public-proof.mjs'])
function getPackageManager() {
  const isWin = process.platform === 'win32'
  const pnpmBin = isWin ? 'pnpm.cmd' : 'pnpm'
  const probe = spawnSync(pnpmBin, ['--version'], { stdio: 'ignore', shell: isWin })
  if (!probe.error && probe.status === 0) return { bin: pnpmBin, isNpm: false }
  return { bin: isWin ? 'npm.cmd' : 'npm', isNpm: true }
}

const pm = getPackageManager()
run('Production build', pm.bin, pm.isNpm ? ['run', 'build'] : ['build'])
run('Integrity tests', pm.bin, pm.isNpm ? ['run', 'test'] : ['test'])

const powerShell = getPowerShell()
if (!powerShell) {
  fail('PowerShell is required to build and inspect the safe submission ZIP')
} else {
  run('Safe submission archive', powerShell, ['-NoProfile', '-File', path.join(root, 'scripts', 'build-safe-zip.ps1')])
  checkArchive(powerShell)
}

if (failures.length) {
  console.error(`\nSUBMISSION CHECK FAILED: ${failures.length} issue(s).`)
  process.exitCode = 1
} else {
  console.log('\nSUBMISSION CHECK PASSED: proof, runtime, build, tests, documents, and archive are clean.')
}
