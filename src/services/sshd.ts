import { Server as SSHServer, utils } from 'ssh2'
import type { Connection, AuthContext, Session, ServerChannel, PseudoTtyInfo } from 'ssh2'
import { ensureConfigDir, HOST_KEY_PATH, writeAuthorizedKeys, ensureHostKeyPermissions } from '@/config/config.ts'
import type { TelebearConfig } from '@/config/config.ts'
import { createServer } from 'node:net'

export interface SshdState {
  server: SSHServer
  port: number
  /** Active client connections — tracked so stopSshd can tear them down. */
  connections: Set<Connection>
}

// ── Host key management ─────────────────────────────────────────────

async function hostKeyExists(): Promise<boolean> {
  return Bun.file(HOST_KEY_PATH).exists()
}

async function generateHostKey(): Promise<{ ok: boolean; message: string }> {
  if (await hostKeyExists()) {
    return { ok: true, message: 'Host key already exists' }
  }
  await ensureConfigDir()
  return new Promise((resolve) => {
    utils.generateKeyPair('ed25519', (err, keys) => {
      if (err) {
        resolve({ ok: false, message: `Host key generation failed: ${err.message}` })
        return
      }
      Bun.write(HOST_KEY_PATH, keys.private, { mode: 0o600 })
        .then(() => resolve({ ok: true, message: 'Host key generated' }))
        .catch((writeErr) => resolve({ ok: false, message: `Host key write failed: ${writeErr.message}` }))
    })
  })
}

async function loadHostKey(): Promise<Buffer | null> {
  try {
    return Buffer.from(await Bun.file(HOST_KEY_PATH).text())
  } catch {
    return null
  }
}

// ── Authorized keys parsing ─────────────────────────────────────────

function parseAuthorizedKeys(keys: string[]): ReturnType<typeof utils.parseKey>[] {
  const parsed: ReturnType<typeof utils.parseKey>[] = []
  for (const key of keys) {
    const trimmed = key.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const result = utils.parseKey(trimmed)
    if (result && !(result instanceof Error)) {
      parsed.push(result)
    }
  }
  return parsed
}

function checkPublicKey(
  ctx: AuthContext & { method: 'publickey'; key: { algo: string; data: Buffer } },
  authorizedKeys: ReturnType<typeof utils.parseKey>[],
): boolean {
  for (const allowed of authorizedKeys) {
    if (allowed === null || allowed instanceof Error) continue
    const parsed = Array.isArray(allowed) ? allowed[0] : allowed
    if (!parsed || parsed instanceof Error) continue
    if (
      ctx.key.algo === parsed.type &&
      ctx.key.data.equals(parsed.getPublicSSH())
    ) {
      return true
    }
  }
  return false
}

// ── Port helpers ────────────────────────────────────────────────────

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function findAvailablePort(preferred: number): Promise<number> {
  if (await isPortAvailable(preferred)) return preferred
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.once('listening', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
    server.listen(0, '127.0.0.1')
  })
}

// ── PTY + Shell (using Bun.Terminal) ────────────────────────────────

function handleSession(
  session: Session,
  onLog: (line: string) => void,
): void {
  let ptyInfo: PseudoTtyInfo | null = null
  let activeTerminal: InstanceType<typeof Bun.Terminal> | null = null

  session.on('pty', (accept, _reject, info) => {
    ptyInfo = info
    accept()
  })

  session.on('window-change', (accept, _reject, info) => {
    if (activeTerminal && !activeTerminal.closed) {
      activeTerminal.resize(info.cols, info.rows)
    }
    accept()
  })

  session.on('shell', (accept) => {
    const channel = accept()
    const userShell = process.env.SHELL || '/bin/sh'
    spawnWithPty(channel, [userShell, '-l'], ptyInfo, onLog)
  })

  session.on('exec', (accept, _reject, info) => {
    const channel = accept()
    const userShell = process.env.SHELL || '/bin/sh'
    spawnWithPty(channel, [userShell, '-c', info.command], ptyInfo, onLog)
  })

  function spawnWithPty(
    channel: ServerChannel,
    cmd: string[],
    pty: PseudoTtyInfo | null,
    log: (line: string) => void,
  ): void {
    const cols = pty?.cols ?? 80
    const rows = pty?.rows ?? 24

    const terminal = new Bun.Terminal({
      cols,
      rows,
      data(_term, data) {
        // PTY output → SSH channel
        if (!channel.destroyed) {
          channel.write(data)
        }
      },
      exit() {
        if (!channel.destroyed) {
          channel.exit(0)
          channel.end()
        }
      },
    })

    activeTerminal = terminal

    const proc = Bun.spawn(cmd, {
      terminal,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        HOME: process.env.HOME || '/',
      },
      cwd: process.env.HOME || '/',
    })

    log(`[sshd] PTY started: ${cmd.join(' ')} (pid ${proc.pid})`)

    // SSH channel input → PTY
    channel.on('data', (data: Buffer) => {
      if (!terminal.closed) {
        terminal.write(data)
      }
    })

    channel.on('close', () => {
      if (!terminal.closed) {
        terminal.close()
      }
      proc.kill()
    })

    proc.exited.then((code) => {
      log(`[sshd] PTY exited (code ${code})`)
      if (!terminal.closed) {
        terminal.close()
      }
      if (!channel.destroyed) {
        channel.exit(code ?? 0)
        channel.end()
      }
      activeTerminal = null
    })
  }
}

// ── Main start/stop ─────────────────────────────────────────────────

export async function startSshd(
  config: TelebearConfig,
  onLog: (line: string) => void,
): Promise<{ ok: boolean; message: string; state?: SshdState }> {
  // Generate host key if needed
  const keyResult = await generateHostKey()
  if (!keyResult.ok) return keyResult
  await ensureHostKeyPermissions()

  // Load host key
  const hostKey = await loadHostKey()
  if (!hostKey) {
    return { ok: false, message: 'Failed to load host key' }
  }

  // Write authorized keys file (for reference/compat)
  await writeAuthorizedKeys(config.ssh.authorized_keys)

  // Parse authorized keys for in-process auth
  const authorizedKeys = parseAuthorizedKeys(config.ssh.authorized_keys)
  if (authorizedKeys.length === 0) {
    return { ok: false, message: 'No valid SSH public keys configured' }
  }

  // Find available port
  const port = await findAvailablePort(config.ssh.port)
  if (port !== config.ssh.port) {
    onLog(`Port ${config.ssh.port} in use, using ${port}`)
  }

  return new Promise((resolve) => {
    let resolved = false
    const connections = new Set<Connection>()

    const server = new SSHServer({ hostKeys: [hostKey] }, (client: Connection) => {
      connections.add(client)
      onLog(`[sshd] Client connected`)

      client.on('authentication', (ctx: AuthContext) => {
        if (ctx.method === 'publickey') {
          const pkCtx = ctx as AuthContext & { method: 'publickey'; key: { algo: string; data: Buffer } }
          if (checkPublicKey(pkCtx, authorizedKeys)) {
            onLog(`[sshd] Auth accepted: ${ctx.username} (publickey)`)
            ctx.accept()
          } else {
            onLog(`[sshd] Auth rejected: ${ctx.username} (publickey - key not found)`)
            ctx.reject()
          }
        } else {
          // Only allow public key auth
          ctx.reject(['publickey'])
        }
      })

      client.on('ready', () => {
        onLog(`[sshd] Client authenticated`)
        client.on('session', (accept) => {
          const session = accept()
          handleSession(session, onLog)
        })
      })

      client.on('close', () => {
        connections.delete(client)
        onLog(`[sshd] Client disconnected`)
      })

      client.on('error', (err) => {
        onLog(`[sshd] Client error: ${err.message}`)
      })
    })

    server.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true
        resolve({ ok: false, message: `SSH server error: ${err.message}` })
      } else {
        onLog(`[sshd] Server error: ${err.message}`)
      }
    })

    onLog(`Starting SSH server on port ${port}`)
    server.listen(port, '127.0.0.1', () => {
      if (resolved) return
      resolved = true
      resolve({
        ok: true,
        message: `SSH server started on port ${port}`,
        state: { server, port, connections },
      })
    })
  })
}

export function stopSshd(state: SshdState): void {
  for (const conn of state.connections) {
    try { conn.end() } catch {}
  }
  state.connections.clear()
  try { state.server.close() } catch {}
}

export function waitForSshdExit(state: SshdState): Promise<void> {
  return new Promise((resolve) => {
    if (!state.server.listening) {
      resolve()
      return
    }
    state.server.once('close', () => resolve())
  })
}
