#!/usr/bin/env node
/**
 * AURA Automated Accounting & Cryptographic Test Runner
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import net from 'node:net'
import fs from 'node:fs'

// Keep the reviewer/test command on the same port documented by the app.
// Reusing a different historical port can collide with an already-running
// Next process and make the test runner report a false failure.
const requestedPort = Number(process.env.PORT || 4173)

async function runAudit(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/audit/test-runner`, { method: 'POST' })
  if (!res.ok) {
    const error = new Error(`Test runner returned HTTP ${res.status}`)
    error.status = res.status
    throw error
  }
  return res.json()
}

async function waitForServer(server, port) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Development server exited with code ${server.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/preflight`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok || response.status === 200 || response.status === 400 || response.status === 401) return
    } catch {
      // The local server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Development server did not become ready within 30 seconds')
}

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ port: startPort, host: '127.0.0.1' }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : startPort
      server.close(() => resolve(port))
    })
  })
}

async function main() {
  let server = null
  let isolatedDataDir = null
  const tsconfigPath = path.join(process.cwd(), 'tsconfig.json')
  const tsconfigSnapshot = fs.readFileSync(tsconfigPath, 'utf8')
  try {
    // Never call the audit route on the user's running demo. The audit suite
    // exercises durable stores and jury-session code; sharing AURA_DATA_DIR
    // would leave test leases and test ledger rows in the live environment.
    // Keep the temporary dist directory inside the project because Next's
    // distDir is resolved relative to the project root. It is removed in the
    // finally block and is never the live .aura-data directory.
    isolatedDataDir = fs.mkdtempSync(path.join(process.cwd(), '.aura-audit-'))
    const port = await findFreePort(Math.max(1024, requestedPort + 1))
    const nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next')
    server = spawn(process.execPath, [nextBin, 'dev', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AURA_DATA_DIR: isolatedDataDir,
        AURA_NEXT_DIST_DIR: path.relative(process.cwd(), path.join(isolatedDataDir, '.next')),
        AURA_DEMO_LOCAL_BOOTSTRAP: 'true',
      },
      stdio: 'inherit',
      windowsHide: true,
    })
    await Promise.race([
      waitForServer(server, port),
      new Promise((_, reject) => server.once('error', reject)),
    ])
    const data = await runAudit(port)

    console.log(`\n========================================`)
    console.log(`AURA INTEGRITY & TESTNET AUDIT SUITE`)
    console.log(`========================================`)
    for (const r of data.results) {
      const mark = r.passed ? '✓' : '✗'
      console.log(`${mark} [${r.suite}] ${r.name} (${r.durationMs}ms)`)
      if (r.error) {
        console.error(`    ERROR: ${r.error}`)
      }
    }
    console.log(`----------------------------------------`)
    console.log(`Total: ${data.summary.total} | Passed: ${data.summary.passed} | Failed: ${data.summary.failed}`)
    if (data.summary.failed > 0) {
      process.exit(1)
    }
    console.log(`All tests passed successfully.\n`)
  } catch (err) {
    console.error('Failed to run audit tests:', err.message)
    process.exitCode = 1
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    if (isolatedDataDir) {
      try { fs.rmSync(isolatedDataDir, { recursive: true, force: true }) } catch {}
    }
    // Next may add temporary type directories to tsconfig.json when it starts
    // a dev server. Restore the project's original config after the isolated
    // audit so the live checkout stays unchanged.
    try { fs.writeFileSync(tsconfigPath, tsconfigSnapshot, 'utf8') } catch {}
  }
}

main()
