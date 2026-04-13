import { rmSync } from 'node:fs'
import { create } from 'zustand'
import { loadConfig, saveConfig, isConfigValid } from '@/config/config.ts'
import type { TelebearConfig } from '@/config/config.ts'
import { startSshd, stopSshd, waitForSshdExit } from '@/services/sshd.ts'
import type { SshdState } from '@/services/sshd.ts'
import { startFrpc, stopFrpc, waitForFrpcExit } from '@/services/frpc.ts'
import type { FrpcState } from '@/services/frpc.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'error'
export type View = 'status' | 'config' | 'log'

interface Notification {
  type: 'success' | 'error' | 'info'
  message: string
}

interface InputDialog {
  title: string
  placeholder: string
  defaultValue?: string
  multiline?: boolean
  field: ConfigField
}

export type ConfigField =
  | 'ssh.authorized_keys'
  | 'ssh.port'
  | 'frp.server_addr'
  | 'frp.server_port'
  | 'frp.token'
  | 'frp.remote_port'

export interface AppState {
  // View
  currentView: View

  // Config
  config: TelebearConfig | null
  configErrors: string[]

  // Service state
  sshStatus: ServiceStatus
  frpcStatus: ServiceStatus
  sshPort: number | null
  tunnelAddress: string | null

  // Logs
  logs: string[]
  lastError: string | null

  // UI state
  notification: Notification | null
  inputDialog: InputDialog | null
  selectedConfigIndex: number
  confirmQuit: boolean

  // Actions
  init: () => Promise<void>
  setCurrentView: (view: View) => void

  // Service actions
  startServices: () => Promise<void>
  stopServices: () => Promise<void>
  restartServices: () => Promise<void>

  // Config actions
  updateConfig: (field: ConfigField, value: string) => Promise<void>
  moveConfigSelection: (delta: number) => void

  // Log actions
  addLog: (line: string) => void
  clearLogs: () => void

  // UI actions
  showNotification: (type: Notification['type'], message: string) => void
  clearNotification: () => void
  showInput: (field: ConfigField) => void
  closeInput: () => void
  setConfirmQuit: (v: boolean) => void
}

// ---------------------------------------------------------------------------
// Internal state (not in zustand to avoid storing process refs)
// ---------------------------------------------------------------------------

let _sshdState: SshdState | null = null
let _frpcState: FrpcState | null = null

let notificationTimer: ReturnType<typeof setTimeout> | null = null

function clearNotificationTimer(): void {
  if (notificationTimer !== null) {
    clearTimeout(notificationTimer)
    notificationTimer = null
  }
}

// Config fields metadata
export const CONFIG_FIELDS: { field: ConfigField; label: string; placeholder: string }[] = [
  { field: 'ssh.authorized_keys', label: 'SSH Public Keys', placeholder: 'ssh-ed25519 AAAA...' },
  { field: 'ssh.port', label: 'SSH Local Port', placeholder: '20222' },
  { field: 'frp.server_addr', label: 'FRP Server Address', placeholder: 'frps.example.com' },
  { field: 'frp.server_port', label: 'FRP Server Port', placeholder: '7000' },
  { field: 'frp.token', label: 'FRP Token', placeholder: 'your-token' },
  { field: 'frp.remote_port', label: 'FRP Remote Port', placeholder: '6000' },
]

const MAX_LOGS = 500

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAppStore = create<AppState>()((set, get) => {
  function addLog(line: string) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false })
    set((s) => ({
      logs: [...s.logs.slice(-(MAX_LOGS - 1)), `[${timestamp}] ${line}`],
    }))
  }

  /** Stop both services and wait for processes to actually exit. */
  async function stopAndWait(): Promise<void> {
    const { sshStatus, frpcStatus } = get()
    const waits: Promise<void>[] = []

    if (_frpcState && (frpcStatus === 'running' || frpcStatus === 'starting')) {
      const state = _frpcState
      waits.push(waitForFrpcExit(state))
      stopFrpc(state)
      _frpcState = null
      set({ frpcStatus: 'stopped', tunnelAddress: null })
      addLog('Stopping frpc...')
    }

    if (_sshdState && (sshStatus === 'running' || sshStatus === 'starting')) {
      const state = _sshdState
      waits.push(waitForSshdExit(state))
      stopSshd(state)
      _sshdState = null
      set({ sshStatus: 'stopped', sshPort: null })
      addLog('Stopping SSH server...')
    }

    await Promise.all(waits)
  }

  return {
    currentView: 'status',

    config: null,
    configErrors: [],

    sshStatus: 'stopped',
    frpcStatus: 'stopped',
    sshPort: null,
    tunnelAddress: null,

    logs: [],
    lastError: null,

    notification: null,
    inputDialog: null,
    selectedConfigIndex: 0,
    confirmQuit: false,

    async init() {
      const result = await loadConfig()
      if (!result.ok) {
        addLog(`Config error: ${result.error}`)
        get().showNotification('error', result.error!)
      }
      const config = result.config
      const { errors } = isConfigValid(config)
      set({ config, configErrors: errors })
      if (result.ok) {
        addLog('Config loaded from ~/.config/telebear/telebear.toml')
      }
      if (errors.length > 0) {
        addLog(`Config issues: ${errors.join(', ')}`)
      }
    },

    setCurrentView(view) {
      set({ currentView: view })
    },

    async startServices() {
      const { config, sshStatus } = get()
      if (!config) return
      if (sshStatus === 'running' || sshStatus === 'starting') return

      const { valid, errors } = isConfigValid(config)
      if (!valid) {
        get().showNotification('error', `Config invalid: ${errors[0]}`)
        return
      }

      // Start SSH server
      set({ sshStatus: 'starting', lastError: null })
      addLog('Starting SSH server...')

      const sshResult = await startSshd(config, addLog)
      if (!sshResult.ok || !sshResult.state) {
        set({ sshStatus: 'error', lastError: `SSH: ${sshResult.message}` })
        addLog(`SSH server failed: ${sshResult.message}`)
        get().showNotification('error', sshResult.message)
        return
      }

      const sshdState = sshResult.state
      _sshdState = sshdState
      const actualPort = sshdState.port
      set({ sshStatus: 'running', sshPort: actualPort })
      addLog(sshResult.message)

      // Watch for SSH server close — only act if this state ref is still current
      sshdState.server.once('close', () => {
        if (_sshdState !== sshdState) return
        _sshdState = null
        set({ sshStatus: 'stopped', sshPort: null })
        addLog('SSH server stopped')
        if (_frpcState) {
          stopFrpc(_frpcState)
          _frpcState = null
          set({ frpcStatus: 'stopped', tunnelAddress: null })
          addLog('frpc stopped (SSH server exited)')
        }
      })

      // Start frpc
      set({ frpcStatus: 'starting' })
      addLog('Starting frpc...')

      const frpcResult = await startFrpc(config, actualPort, addLog)
      if (!frpcResult.ok || !frpcResult.state) {
        set({ frpcStatus: 'error', lastError: `FRP: ${frpcResult.message}` })
        addLog(`frpc failed: ${frpcResult.message}`)
        get().showNotification('error', frpcResult.message)

        // Rollback: stop SSH server since tunnel failed
        if (_sshdState === sshdState) {
          _sshdState = null
          addLog('Rolling back: stopping SSH server (frpc failed)')
          stopSshd(sshdState)
          await waitForSshdExit(sshdState)
          set({ sshStatus: 'stopped', sshPort: null })
        }
        return
      }

      const frpcState = frpcResult.state
      _frpcState = frpcState
      set({
        frpcStatus: 'running',
        tunnelAddress: `${config.frp.server_addr}:${config.frp.remote_port}`,
      })
      addLog(frpcResult.message)
      get().showNotification('success', `Tunnel: ssh -p ${config.frp.remote_port} user@${config.frp.server_addr}`)

      // Watch for frpc exit — only act if this state ref is still current
      frpcState.process?.on('close', () => {
        if (_frpcState !== frpcState) return
        _frpcState = null
        set({ frpcStatus: 'stopped', tunnelAddress: null })
        addLog('frpc stopped')
      })
    },

    async stopServices() {
      await stopAndWait()
      set({ lastError: null })
      get().showNotification('info', 'Services stopped')
    },

    async restartServices() {
      addLog('Restarting services...')
      await stopAndWait()
      set({ lastError: null })
      await get().startServices()
    },

    async updateConfig(field, value) {
      const config = get().config
      if (!config) return

      const updated = { ...config, ssh: { ...config.ssh }, frp: { ...config.frp } }

      switch (field) {
        case 'ssh.authorized_keys':
          updated.ssh.authorized_keys = value
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
          break
        case 'ssh.port':
          updated.ssh.port = parseInt(value, 10) || 20222
          break
        case 'frp.server_addr':
          updated.frp.server_addr = value.trim()
          break
        case 'frp.server_port':
          updated.frp.server_port = parseInt(value, 10) || 7000
          break
        case 'frp.token':
          updated.frp.token = value.trim()
          break
        case 'frp.remote_port':
          updated.frp.remote_port = parseInt(value, 10) || 0
          break
      }

      await saveConfig(updated)
      const { errors } = isConfigValid(updated)
      set({ config: updated, configErrors: errors })

      const { sshStatus, frpcStatus } = get()
      const servicesRunning = sshStatus === 'running' || frpcStatus === 'running'
      if (servicesRunning) {
        get().showNotification('info', 'Config saved. Press r to restart services')
        addLog(`Config updated: ${field} (restart needed to apply)`)
      } else {
        get().showNotification('success', 'Config saved')
        addLog(`Config updated: ${field}`)
      }
    },

    moveConfigSelection(delta) {
      set((s) => ({
        selectedConfigIndex: Math.max(0, Math.min(CONFIG_FIELDS.length - 1, s.selectedConfigIndex + delta)),
      }))
    },

    addLog(line) {
      addLog(line)
    },

    clearLogs() {
      set({ logs: [] })
    },

    showNotification(type, message) {
      clearNotificationTimer()
      set({ notification: { type, message } })
      notificationTimer = setTimeout(() => {
        notificationTimer = null
        set({ notification: null })
      }, 4000)
    },

    clearNotification() {
      clearNotificationTimer()
      set({ notification: null })
    },

    showInput(field) {
      const meta = CONFIG_FIELDS.find((f) => f.field === field)
      if (!meta) return
      const config = get().config
      if (!config) return

      let defaultValue = ''
      switch (field) {
        case 'ssh.authorized_keys':
          defaultValue = config.ssh.authorized_keys.join('\n')
          break
        case 'ssh.port':
          defaultValue = String(config.ssh.port)
          break
        case 'frp.server_addr':
          defaultValue = config.frp.server_addr
          break
        case 'frp.server_port':
          defaultValue = String(config.frp.server_port)
          break
        case 'frp.token':
          defaultValue = config.frp.token
          break
        case 'frp.remote_port':
          defaultValue = String(config.frp.remote_port)
          break
      }

      set({
        inputDialog: {
          title: meta.label,
          placeholder: meta.placeholder,
          defaultValue,
          multiline: field === 'ssh.authorized_keys',
          field,
        },
      })
    },

    closeInput() {
      set({ inputDialog: null })
    },

    setConfirmQuit(v) {
      set({ confirmQuit: v })
    },
  }
})

export function selectIsInputBlocked(s: AppState): boolean {
  return s.inputDialog !== null || s.confirmQuit
}

// Cleanup function for process exit (synchronous, best-effort)
export function cleanupServices(): void {
  if (_frpcState?.process && !_frpcState.process.killed) {
    try { _frpcState.process.kill('SIGTERM') } catch {}
    try { _frpcState.process.kill('SIGKILL') } catch {}
  }
  if (_frpcState?.tempDir) {
    try { rmSync(_frpcState.tempDir, { recursive: true, force: true }) } catch {}
  }
  _frpcState = null

  if (_sshdState) {
    for (const conn of _sshdState.connections) {
      try { conn.end() } catch {}
    }
    _sshdState.connections.clear()
    try { _sshdState.server.close() } catch {}
  }
  _sshdState = null
}
