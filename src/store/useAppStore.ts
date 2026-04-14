import { create } from 'zustand'
import { loadConfig, saveConfig, isConfigValid } from '@/config/config.ts'
import type { TelebearConfig } from '@/config/config.ts'
import { ServiceManager } from '@/services/ServiceManager.ts'
import type { ServiceStatus, ServiceSnapshot } from '@/services/ServiceManager.ts'
import type { ClientInfo } from '@/services/sshd.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ServiceStatus }

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
  // Config
  config: TelebearConfig | null
  configErrors: string[]

  // Service state (synced from ServiceManager)
  sshStatus: ServiceStatus
  frpcStatus: ServiceStatus
  sshPort: number | null
  tunnelAddress: string | null
  activeClients: ClientInfo[]
  lastError: string | null

  // Logs
  logs: string[]

  // UI state
  notification: Notification | null
  inputDialog: InputDialog | null
  selectedConfigIndex: number
  confirmQuit: boolean

  // Actions
  init: () => Promise<void>

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
// Constants
// ---------------------------------------------------------------------------

export const CONFIG_FIELDS: { field: ConfigField; label: string; placeholder: string }[] = [
  { field: 'ssh.authorized_keys', label: 'SSH Public Keys', placeholder: 'ssh-ed25519 AAAA...' },
  { field: 'ssh.port', label: 'SSH Local Port', placeholder: '20222' },
  { field: 'frp.server_addr', label: 'FRP Server Address', placeholder: 'frps.example.com' },
  { field: 'frp.server_port', label: 'FRP Server Port', placeholder: '7000' },
  { field: 'frp.token', label: 'FRP Token', placeholder: 'your-token' },
  { field: 'frp.remote_port', label: 'FRP Remote Port', placeholder: '0 = same as local port' },
]

const MAX_LOGS = 500

// ---------------------------------------------------------------------------
// Notification timer (module-level, not in zustand)
// ---------------------------------------------------------------------------

let notificationTimer: ReturnType<typeof setTimeout> | null = null

function clearNotificationTimer(): void {
  if (notificationTimer !== null) {
    clearTimeout(notificationTimer)
    notificationTimer = null
  }
}

// ---------------------------------------------------------------------------
// Service manager (singleton, owns all process state)
// ---------------------------------------------------------------------------

let _manager: ServiceManager | null = null

function getManager(addLog: (line: string) => void): ServiceManager {
  if (!_manager) {
    _manager = new ServiceManager(addLog)
  }
  return _manager
}

/** Called from main.ts on process exit. */
export function cleanupServices(): void {
  _manager?.cleanup()
}

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

  const manager = getManager(addLog)

  // Surface unexpected service errors as notifications
  manager.onError = (message: string) => {
    get().showNotification('error', message)
  }

  // Subscribe: whenever the manager's service state changes, sync to zustand
  manager.subscribe((snap: ServiceSnapshot) => {
    set({
      sshStatus: snap.sshStatus,
      frpcStatus: snap.frpcStatus,
      sshPort: snap.sshPort,
      tunnelAddress: snap.tunnelAddress,
      activeClients: snap.activeClients,
      lastError: snap.lastError,
    })
  })

  return {
    config: null,
    configErrors: [],

    sshStatus: 'stopped',
    frpcStatus: 'stopped',
    sshPort: null,
    tunnelAddress: null,
    activeClients: [],

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

    async startServices() {
      const { config } = get()
      if (!config) return

      const { valid, errors } = isConfigValid(config)
      if (!valid) {
        get().showNotification('error', `Config invalid: ${errors[0]}`)
        return
      }

      const result = await manager.start(config)
      if (result.ok) {
        get().showNotification('success', `Tunnel: ${result.message}`)
      } else {
        get().showNotification('error', result.message!)
      }
    },

    async stopServices() {
      await manager.stop()
      get().showNotification('info', 'Services stopped')
    },

    async restartServices() {
      const { config } = get()
      if (!config) return

      const result = await manager.restart(config)
      if (result.ok) {
        get().showNotification('success', `Tunnel: ${result.message}`)
      } else {
        get().showNotification('error', result.message!)
      }
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
        case 'ssh.port': {
          const port = parseInt(value, 10)
          if (isNaN(port) || port <= 0 || port > 65535) {
            get().showNotification('error', 'Invalid port number')
            return
          }
          updated.ssh.port = port
          break
        }
        case 'frp.server_addr':
          updated.frp.server_addr = value.trim()
          break
        case 'frp.server_port': {
          const port = parseInt(value, 10)
          if (isNaN(port) || port <= 0 || port > 65535) {
            get().showNotification('error', 'Invalid port number')
            return
          }
          updated.frp.server_port = port
          break
        }
        case 'frp.token':
          updated.frp.token = value.trim()
          break
        case 'frp.remote_port': {
          const port = parseInt(value, 10)
          if (isNaN(port) || port < 0 || port > 65535) {
            get().showNotification('error', 'Invalid port number (0 = same as local)')
            return
          }
          updated.frp.remote_port = port
          break
        }
      }

      await saveConfig(updated)
      const { errors } = isConfigValid(updated)
      set({ config: updated, configErrors: errors })

      if (manager.isRunning) {
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
