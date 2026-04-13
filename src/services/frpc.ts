import { spawn, type ChildProcess } from 'node:child_process'
import { rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stringify } from 'smol-toml'
import type { TelebearConfig } from '@/config/config.ts'

const textDecoder = new TextDecoder()

function decodeChunk(chunk: Uint8Array): string {
  return textDecoder.decode(chunk)
}

export interface FrpcState {
  process: ChildProcess | null
  pid: number | null
  tempDir: string | null
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

    onLog(`Starting frpc -> ${config.frp.server_addr}:${config.frp.server_port}`)
    const proc = spawn('frpc', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const handleOutput = (chunk: Uint8Array) => {
      const lines = decodeChunk(chunk).split('\n').filter(Boolean)
      lines.forEach((l) => {
        onLog(`[frpc] ${l}`)
        // frpc logs "start proxy success" when tunnel is established
        if (!resolved && (l.includes('start proxy success') || l.includes('login to server success'))) {
          resolved = true
          resolve({
            ok: true,
            message: `FRP tunnel established -> ${config.frp.server_addr}:${config.frp.remote_port}`,
            state: { process: proc, pid: proc.pid ?? null, tempDir },
          })
        }
      })
    }

    proc.stdout?.on('data', handleOutput)
    proc.stderr?.on('data', handleOutput)

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true
        cleanupTempDir(tempDir)
        resolve({ ok: false, message: `frpc error: ${err.message}` })
      } else {
        onLog(`[frpc] error: ${err.message}`)
      }
    })

    proc.on('close', (code) => {
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
