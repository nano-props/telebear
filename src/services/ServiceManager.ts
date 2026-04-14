import { rmSync } from 'node:fs'
import type { TelebearConfig } from '@/config/config.ts'
import { startSshd, stopSshd, waitForSshdExit } from '@/services/sshd.ts'
import type { SshdState, ClientInfo } from '@/services/sshd.ts'
import { startFrpc, stopFrpc, waitForFrpcExit } from '@/services/frpc.ts'
import type { FrpcState } from '@/services/frpc.ts'

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface ServiceSnapshot {
  sshStatus: ServiceStatus
  frpcStatus: ServiceStatus
  sshPort: number | null
  tunnelAddress: string | null
  activeClients: ClientInfo[]
  lastError: string | null
}

type Listener = (snapshot: ServiceSnapshot) => void

/**
 * Manages the lifecycle of the SSH server and FRP tunnel.
 *
 * Owns all mutable process state (_sshdState, _frpcState) and exposes
 * a simple snapshot that the zustand store can subscribe to.
 */
export class ServiceManager {
  private _sshdState: SshdState | null = null
  private _frpcState: FrpcState | null = null

  private _sshStatus: ServiceStatus = 'stopped'
  private _frpcStatus: ServiceStatus = 'stopped'
  private _sshPort: number | null = null
  private _tunnelAddress: string | null = null
  private _lastError: string | null = null

  private _listener: Listener | null = null
  private _onLog: (line: string) => void
  private _onError: ((message: string) => void) | null = null

  constructor(onLog: (line: string) => void) {
    this._onLog = onLog
  }

  /** Set a callback for service errors that need user attention (e.g. unexpected exit). */
  set onError(fn: (message: string) => void) {
    this._onError = fn
  }

  /** Subscribe to state changes. Only one listener (the store). */
  subscribe(listener: Listener): void {
    this._listener = listener
  }

  /** Current snapshot for the store to read. */
  get snapshot(): ServiceSnapshot {
    return {
      sshStatus: this._sshStatus,
      frpcStatus: this._frpcStatus,
      sshPort: this._sshPort,
      tunnelAddress: this._tunnelAddress,
      activeClients: this._sshdState
        ? Array.from(this._sshdState.clients.values())
        : [],
      lastError: this._lastError,
    }
  }

  get isRunning(): boolean {
    return this._sshStatus === 'running' || this._frpcStatus === 'running'
  }

  get isStarting(): boolean {
    return this._sshStatus === 'starting' || this._frpcStatus === 'starting'
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(config: TelebearConfig): Promise<{ ok: boolean; message?: string }> {
    if (this._sshStatus === 'running' || this._sshStatus === 'starting') {
      return { ok: false, message: 'Already running' }
    }

    // ── SSH ──────────────────────────────────────────────────────────
    this._update({ sshStatus: 'starting', lastError: null })
    this._onLog('Starting SSH server...')

    const sshResult = await startSshd(config, this._onLog, () => this._notify())
    if (!sshResult.ok || !sshResult.state) {
      this._update({ sshStatus: 'error', lastError: `SSH: ${sshResult.message}` })
      this._onLog(`SSH server failed: ${sshResult.message}`)
      return { ok: false, message: sshResult.message }
    }

    const sshdState = sshResult.state
    this._sshdState = sshdState
    this._update({ sshStatus: 'running', sshPort: sshdState.port })
    this._onLog(sshResult.message)

    // Watch for unexpected SSH close
    sshdState.server.once('close', () => {
      if (this._sshdState !== sshdState) return
      this._sshdState = null
      this._onLog('SSH server stopped')

      // Cascade: stop frpc too
      if (this._frpcState) {
        stopFrpc(this._frpcState)
        this._frpcState = null
        this._onLog('frpc stopped (SSH server exited)')
      }
      this._update({
        sshStatus: 'stopped', sshPort: null,
        frpcStatus: 'stopped', tunnelAddress: null,
      })
      this._onError?.('SSH server stopped unexpectedly — services stopped')
    })

    // ── FRP ──────────────────────────────────────────────────────────
    // Resolve remote_port: 0 means "same as local SSH port"
    const effectiveConfig = config.frp.remote_port === 0
      ? { ...config, frp: { ...config.frp, remote_port: sshdState.port } }
      : config

    this._update({ frpcStatus: 'starting' })
    this._onLog('Starting frpc...')

    const frpcResult = await startFrpc(effectiveConfig, sshdState.port, this._onLog)
    if (!frpcResult.ok || !frpcResult.state) {
      this._update({ frpcStatus: 'error', lastError: `FRP: ${frpcResult.message}` })
      this._onLog(`frpc failed: ${frpcResult.message}`)

      // Rollback SSH
      if (this._sshdState === sshdState) {
        this._sshdState = null
        this._onLog('Rolling back: stopping SSH server (frpc failed)')
        stopSshd(sshdState)
        await waitForSshdExit(sshdState)
        this._update({ sshStatus: 'stopped', sshPort: null })
      }
      return { ok: false, message: frpcResult.message }
    }

    const frpcState = frpcResult.state
    this._frpcState = frpcState
    const remotePort = frpcState.actualRemotePort ?? effectiveConfig.frp.remote_port
    this._update({
      frpcStatus: 'running',
      tunnelAddress: `${config.frp.server_addr}:${remotePort}`,
    })
    this._onLog(frpcResult.message)

    // Watch for unexpected frpc exit
    frpcState.process?.on('close', () => {
      if (this._frpcState !== frpcState) return
      this._frpcState = null
      this._onLog('frpc stopped unexpectedly')

      // Cascade: stop SSH too
      if (this._sshdState) {
        const sshState = this._sshdState
        this._sshdState = null
        this._onLog('Stopping SSH server (tunnel lost)')
        stopSshd(sshState)
      }
      this._update({
        frpcStatus: 'stopped', tunnelAddress: null,
        sshStatus: 'stopped', sshPort: null,
      })
      this._onError?.('Tunnel lost — services stopped')
    })

    return { ok: true, message: `ssh -p ${remotePort} user@${config.frp.server_addr}` }
  }

  async stop(): Promise<void> {
    const waits: Promise<void>[] = []

    if (this._frpcState && (this._frpcStatus === 'running' || this._frpcStatus === 'starting')) {
      const state = this._frpcState
      waits.push(waitForFrpcExit(state))
      stopFrpc(state)
      this._frpcState = null
      this._onLog('Stopping frpc...')
    }

    if (this._sshdState && (this._sshStatus === 'running' || this._sshStatus === 'starting')) {
      const state = this._sshdState
      waits.push(waitForSshdExit(state))
      stopSshd(state)
      this._sshdState = null
      this._onLog('Stopping SSH server...')
    }

    await Promise.all(waits)
    this._update({
      sshStatus: 'stopped', sshPort: null,
      frpcStatus: 'stopped', tunnelAddress: null,
      lastError: null,
    })
  }

  async restart(config: TelebearConfig): Promise<{ ok: boolean; message?: string }> {
    this._onLog('Restarting services...')
    await this.stop()
    return this.start(config)
  }

  /** Synchronous best-effort cleanup for process exit handlers. */
  cleanup(): void {
    if (this._frpcState?.process && !this._frpcState.process.killed) {
      try { this._frpcState.process.kill('SIGTERM') } catch {}
      try { this._frpcState.process.kill('SIGKILL') } catch {}
    }
    if (this._frpcState?.tempDir) {
      try { rmSync(this._frpcState.tempDir, { recursive: true, force: true }) } catch {}
    }
    this._frpcState = null

    if (this._sshdState) {
      for (const conn of this._sshdState.connections) {
        try { conn.end() } catch {}
      }
      this._sshdState.connections.clear()
      try { this._sshdState.server.close() } catch {}
    }
    this._sshdState = null
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _update(partial: Partial<Omit<ServiceSnapshot, 'activeClients'>>): void {
    if (partial.sshStatus !== undefined) this._sshStatus = partial.sshStatus
    if (partial.frpcStatus !== undefined) this._frpcStatus = partial.frpcStatus
    if (partial.sshPort !== undefined) this._sshPort = partial.sshPort
    if (partial.tunnelAddress !== undefined) this._tunnelAddress = partial.tunnelAddress
    if (partial.lastError !== undefined) this._lastError = partial.lastError
    this._notify()
  }

  private _notify(): void {
    this._listener?.(this.snapshot)
  }
}
