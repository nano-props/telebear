import { spawn, type ChildProcess } from 'node:child_process'
import { rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stringify } from 'smol-toml'
import type { TelebearConfig } from '@/config/config.ts'

/** Line-buffered stream decoder — handles multi-byte chars split across chunks. */
class LineBuffer {
  private decoder = new TextDecoder()
  private partial = ''

  feed(chunk: Uint8Array): string[] {
    this.partial += this.decoder.decode(chunk, { stream: true })
    const parts = this.partial.split('\n')
    // Last element is the incomplete line (or '' if chunk ended with \n)
    this.partial = parts.pop()!
    return parts.filter(Boolean)
  }

  /** Flush any remaining partial line. */
  flush(): string | null {
    const rest = this.partial + this.decoder.decode()
    this.partial = ''
    return rest || null
  }
}

export interface FrpcState {
  process: ChildProcess | null
  pid: number | null
  tempDir: string | null
  /** Actual remote port assigned by frps (may differ from config when remote_port=0). */
  actualRemotePort: number | null
}

function generateFrpcConfig(config: TelebearConfig, localPort: number): string {
  const frpcConfig = {
    serverAddr: config.frp.server_addr,
    serverPort: config.frp.server_port,
    auth: {
      token: config.frp.token,
    },
    proxies: [
      {
        name: 'telebear-ssh',
        type: 'tcp',
        localIP: '127.0.0.1',
        localPort: localPort,
        remotePort: config.frp.remote_port,
      },
    ],
  }
  return stringify(frpcConfig as unknown as Record<string, unknown>)
}

export async function startFrpc(
  config: TelebearConfig,
  localPort: number,
  onLog: (line: string) => void,
): Promise<{ ok: boolean; message: string; state?: FrpcState }> {
  // Write frpc config to a unique temp file with restricted permissions
  const tempDir = await mkdtemp(join(tmpdir(), 'telebear-'))
  const configPath = join(tempDir, 'frpc.toml')
  const configContent = generateFrpcConfig(config, localPort)
  await Bun.write(configPath, configContent, { mode: 0o600 })
  onLog(`frpc config written to ${configPath}`)

  return new Promise((resolve) => {
    const args = ['-c', configPath]
    let resolved = false
    const stdoutBuf = new LineBuffer()
    const stderrBuf = new LineBuffer()

    onLog(`Starting frpc -> ${config.frp.server_addr}:${config.frp.server_port}`)
    const proc = spawn('frpc', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Track the actual remote port (may be assigned by frps when config remote_port=0)
    let actualRemotePort: number | null = null

    const handleLines = (lines: string[]) => {
      for (const l of lines) {
        onLog(`[frpc] ${l}`)

        // Try to extract actual remote port from frpc log (e.g. "remote_port = 12345")
        const portMatch = l.match(/remote[_\s]port\D+(\d+)/)
        if (portMatch) {
          actualRemotePort = parseInt(portMatch[1]!, 10)
        }

        // frpc logs "start proxy success" when tunnel is established
        if (!resolved && l.includes('start proxy success')) {
          resolved = true
          const port = actualRemotePort ?? config.frp.remote_port
          resolve({
            ok: true,
            message: `FRP tunnel established -> ${config.frp.server_addr}:${port}`,
            state: { process: proc, pid: proc.pid ?? null, tempDir, actualRemotePort: port },
          })
        }
      }
    }

    proc.stdout?.on('data', (chunk: Uint8Array) => handleLines(stdoutBuf.feed(chunk)))
    proc.stderr?.on('data', (chunk: Uint8Array) => handleLines(stderrBuf.feed(chunk)))

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true
        cleanupTempDir(tempDir)
        const message = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'frpc not found in PATH. Install it with: ./setup-frp.sh'
          : `frpc error: ${err.message}`
        resolve({ ok: false, message })
      } else {
        onLog(`[frpc] error: ${err.message}`)
      }
    })

    proc.on('close', (code) => {
      // Flush any remaining partial lines
      for (const buf of [stdoutBuf, stderrBuf]) {
        const rest = buf.flush()
        if (rest) onLog(`[frpc] ${rest}`)
      }
      if (!resolved) {
        resolved = true
        cleanupTempDir(tempDir)
        resolve({ ok: false, message: `frpc exited with code ${code}` })
      } else {
        onLog(`[frpc] exited (code ${code})`)
      }
    })

    // Timeout: if no success message after 10s, this is a failure, not optimistic success
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        proc.kill('SIGTERM')
        cleanupTempDir(tempDir)
        resolve({
          ok: false,
          message: `frpc failed to establish tunnel within 10s`,
        })
      }
    }, 10000)
  })
}

export function stopFrpc(state: FrpcState): void {
  if (state.process && !state.process.killed) {
    state.process.kill('SIGTERM')
  }
  if (state.tempDir) {
    cleanupTempDir(state.tempDir)
  }
}

/** Returns a promise that resolves when the process exits. */
export function waitForFrpcExit(state: FrpcState): Promise<void> {
  return new Promise((resolve) => {
    if (!state.process || state.process.killed) {
      resolve()
      return
    }
    state.process.once('close', () => resolve())
  })
}

function cleanupTempDir(dir: string): void {
  rm(dir, { recursive: true, force: true }).catch(() => {})
}
