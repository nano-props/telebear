import { Server as SSHServer, utils } from 'ssh2'
import type { Connection, AuthContext, Session, ServerChannel, PseudoTtyInfo } from 'ssh2'
import { ensureConfigDir, HOST_KEY_PATH, writeAuthorizedKeys, ensureHostKeyPermissions } from '@/config/config.ts'
import type { TelebearConfig } from '@/config/config.ts'

export interface ClientInfo {
  username: string
  connectedAt: Date
}

export interface SshdState {
  server: SSHServer
  port: number
  /** Active client connections — tracked so stopSshd can tear them down. */
  connections: Set<Connection>
  /** Info about each authenticated client. Keyed by Connection reference. */
  clients: Map<Connection, ClientInfo>
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

/** Try to listen on preferred port; on EADDRINUSE, fall back to OS-assigned port. */
function listenWithFallback(
  server: SSHServer,
  preferred: number,
  onLog: (line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    function tryListen(port: number) {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) {
          onLog(`Port ${port} in use, trying random port`)
          tryListen(0)
        } else {
          reject(err)
        }
      }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        const addr = server.address()
        const actualPort = typeof addr === 'object' && addr ? addr.port : port
        resolve(actualPort)
      })
    }
    tryListen(preferred)
  })
}

// ── PTY + Shell (using Bun.Terminal) ────────────────────────────────

/** Standard env vars safe to pass to SSH sessions. */
const ALLOWED_ENV_KEYS = new Set([
  'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TERM_PROGRAM', 'COLORTERM', 'EDITOR', 'VISUAL', 'PAGER', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
])

function buildCleanEnv(extraTerm?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  env.HOME = process.env.HOME || '/'
  if (extraTerm) env.TERM = extraTerm
  return env
}

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
    accept?.()
  })

  session.on('shell', (accept) => {
    const channel = accept()
    const userShell = process.env.SHELL || '/bin/sh'
    spawnWithPty(channel, [userShell, '-l'], ptyInfo, onLog)
  })

  session.on('exec', (accept, _reject, info) => {
    const channel = accept()
    const userShell = process.env.SHELL || '/bin/sh'
    if (ptyInfo) {
      spawnWithPty(channel, [userShell, '-c', info.command], ptyInfo, onLog)
    } else {
      spawnWithPipe(channel, [userShell, '-c', info.command], onLog)
    }
  })

  // ── PTY mode (shell, exec with PTY) ────────────────────────────────

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
        if (!channel.destroyed) channel.write(data)
      },
      exit() {
        if (!channel.destroyed) { channel.exit(0); channel.end() }
      },
    })

    activeTerminal = terminal

    const proc = Bun.spawn(cmd, {
      terminal,
      env: buildCleanEnv('xterm-256color'),
      cwd: process.env.HOME || '/',
    })

    log(`[sshd] PTY started: ${cmd.join(' ')} (pid ${proc.pid})`)

    channel.on('data', (data: Buffer) => {
      if (!terminal.closed) terminal.write(data)
    })

    channel.on('close', () => {
      if (!terminal.closed) terminal.close()
      try { proc.kill() } catch {}
    })

    proc.exited.then((code) => {
      log(`[sshd] PTY exited (code ${code})`)
      if (!terminal.closed) terminal.close()
      if (!channel.destroyed) { channel.exit(code ?? 0); channel.end() }
      activeTerminal = null
    })
  }

  // ── Pipe mode (exec without PTY — safe for scp/rsync/git) ─────────

  function spawnWithPipe(
    channel: ServerChannel,
    cmd: string[],
    log: (line: string) => void,
  ): void {
    const proc = Bun.spawn(cmd, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: buildCleanEnv(),
      cwd: process.env.HOME || '/',
    })

    log(`[sshd] Exec started: ${cmd.join(' ')} (pid ${proc.pid})`)

    // stdout/stderr → channel
    if (proc.stdout) {
      const reader = proc.stdout.getReader()
      ;(async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!channel.destroyed) channel.write(value)
          }
        } catch {}
      })()
    }
    if (proc.stderr) {
      const reader = proc.stderr.getReader()
      ;(async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!channel.destroyed) channel.stderr.write(value)
          }
        } catch {}
      })()
    }

    // channel → stdin
    channel.on('data', (data: Buffer) => {
      try { proc.stdin.write(data) } catch {}
    })
    channel.on('end', () => {
      try { proc.stdin.end() } catch {}
    })

    channel.on('close', () => {
      try { proc.kill() } catch {}
    })

    proc.exited.then((code) => {
      log(`[sshd] Exec exited (code ${code})`)
      if (!channel.destroyed) { channel.exit(code ?? 0); channel.end() }
    })
  }
}

// ── Main start/stop ─────────────────────────────────────────────────

export async function startSshd(
  config: TelebearConfig,
  onLog: (line: string) => void,
  onClientChange?: () => void,
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

  const connections = new Set<Connection>()
  const clients = new Map<Connection, ClientInfo>()

  const server = new SSHServer({ hostKeys: [hostKey] }, (client: Connection) => {
    connections.add(client)
    onLog(`[sshd] Client connected`)

    // Stash username from auth phase so we can use it after ready
    let authedUsername = ''

    client.on('authentication', (ctx: AuthContext) => {
      if (ctx.method === 'publickey') {
        const pkCtx = ctx as AuthContext & { method: 'publickey'; key: { algo: string; data: Buffer } }
        if (checkPublicKey(pkCtx, authorizedKeys)) {
          authedUsername = ctx.username
          onLog(`[sshd] Auth accepted: ${ctx.username} (publickey)`)
          ctx.accept()
        } else {
          onLog(`[sshd] Auth rejected: ${ctx.username} (publickey - key not found)`)
          ctx.reject()
        }
      } else {
        ctx.reject(['publickey'])
      }
    })

    client.on('ready', () => {
      onLog(`[sshd] Client authenticated: ${authedUsername}`)
      clients.set(client, { username: authedUsername, connectedAt: new Date() })
      onClientChange?.()

      client.on('session', (accept) => {
        const session = accept()
        handleSession(session, onLog)
      })
    })

    client.on('close', () => {
      connections.delete(client)
      const wasAuthenticated = clients.has(client)
      const info = clients.get(client)
      clients.delete(client)
      onLog(`[sshd] Client disconnected: ${info?.username ?? 'unknown'}`)
      if (wasAuthenticated) onClientChange?.()
    })

    client.on('error', (err) => {
      onLog(`[sshd] Client error: ${err.message}`)
    })
  })

  // Log runtime server errors (after startup, these are non-fatal)
  server.on('error', (err: Error) => {
    onLog(`[sshd] Server error: ${err.message}`)
  })

  // Listen with automatic fallback to random port if preferred is busy
  try {
    const port = await listenWithFallback(server, config.ssh.port, onLog)
    onLog(`SSH server started on port ${port}`)
    return {
      ok: true,
      message: `SSH server started on port ${port}`,
      state: { server, port, connections, clients },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `SSH server error: ${message}` }
  }
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
