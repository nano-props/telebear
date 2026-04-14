import React, { useState, useEffect, useRef } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import Spinner from 'ink-spinner'
import { useAppStore, CONFIG_FIELDS, selectIsInputBlocked } from '@/store/useAppStore.ts'
import { InputDialog } from '@/ui/components/InputDialog.tsx'
import { ServicesPanel } from '@/ui/panels/ServicesPanel.tsx'
import { ConfigPanel } from '@/ui/panels/ConfigPanel.tsx'
import { LogPanel, LOG_LINES } from '@/ui/panels/LogPanel.tsx'

const MIN_COLS = 60
const MIN_ROWS = 20

function useTerminalSize() {
  const [size, setSize] = useState({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  })
  useEffect(() => {
    const onResize = () => setSize({ cols: process.stdout.columns, rows: process.stdout.rows })
    process.stdout.on('resize', onResize)
    return () => { process.stdout.off('resize', onResize) }
  }, [])
  return size
}

export function App() {
  const { exit } = useApp()
  const { cols, rows } = useTerminalSize()
  const tooSmall = cols < MIN_COLS || rows < MIN_ROWS

  useInput((input) => { if (input === 'q') exit() }, { isActive: tooSmall })

  if (tooSmall) {
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <Text color="yellow">Terminal too small</Text>
        <Text dimColor>Need at least {MIN_COLS}x{MIN_ROWS}, current {cols}x{rows}</Text>
        <Text dimColor>Resize or press q to quit</Text>
      </Box>
    )
  }

  return <AppMain cols={cols} />
}

function AppMain({ cols }: { cols: number }) {
  const { exit } = useApp()

  // Only subscribe to what AppMain actually renders or needs for keybindings
  const config = useAppStore((s) => s.config)
  const configErrors = useAppStore((s) => s.configErrors)
  const sshStatus = useAppStore((s) => s.sshStatus)
  const frpcStatus = useAppStore((s) => s.frpcStatus)
  const sshPort = useAppStore((s) => s.sshPort)
  const tunnelAddress = useAppStore((s) => s.tunnelAddress)
  const lastError = useAppStore((s) => s.lastError)
  const logs = useAppStore((s) => s.logs)
  const notification = useAppStore((s) => s.notification)
  const inputDialog = useAppStore((s) => s.inputDialog)
  const confirmQuit = useAppStore((s) => s.confirmQuit)
  const selectedConfigIndex = useAppStore((s) => s.selectedConfigIndex)

  const init = useAppStore((s) => s.init)
  const startServices = useAppStore((s) => s.startServices)
  const stopServices = useAppStore((s) => s.stopServices)
  const restartServices = useAppStore((s) => s.restartServices)
  const moveConfigSelection = useAppStore((s) => s.moveConfigSelection)
  const showInput = useAppStore((s) => s.showInput)
  const closeInput = useAppStore((s) => s.closeInput)
  const updateConfig = useAppStore((s) => s.updateConfig)
  const clearLogs = useAppStore((s) => s.clearLogs)
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit)

  const isBlocked = useAppStore(selectIsInputBlocked)
  const isRunning = sshStatus === 'running' || frpcStatus === 'running'
  const isStarting = sshStatus === 'starting' || frpcStatus === 'starting'
  const isError = sshStatus === 'error' || frpcStatus === 'error'

  // Log scroll state (derived from logs which AppMain subscribes to for keybindings)
  const [scrollOffset, setScrollOffset] = useState(-1)
  const maxOffset = Math.max(0, logs.length - LOG_LINES)
  const maxOffsetRef = useRef(maxOffset)
  maxOffsetRef.current = maxOffset
  const effectiveOffset = scrollOffset === -1 ? maxOffset : Math.min(scrollOffset, maxOffset)
  const isAtBottom = scrollOffset === -1

  useEffect(() => { if (logs.length === 0) setScrollOffset(-1) }, [logs.length])

  // Init
  useEffect(() => { init() }, [])

  // Confirm quit
  useInput(
    (input) => {
      if (input === 'y' || input === 'Y') { stopServices().then(() => exit()); return }
      setConfirmQuit(false)
    },
    { isActive: confirmQuit },
  )

  // All keybindings
  useInput(
    (input, key) => {
      if (input === 'q') {
        if (isRunning || isStarting) setConfirmQuit(true)
        else exit()
        return
      }
      if (input === 's') {
        if (isRunning || isStarting) stopServices()
        else startServices()
        return
      }
      if (input === 'r' && (isRunning || isStarting || isError)) { restartServices(); return }

      // Config navigation
      if (key.upArrow) { moveConfigSelection(-1); return }
      if (key.downArrow) { moveConfigSelection(1); return }
      if (key.return) {
        const field = CONFIG_FIELDS[selectedConfigIndex]
        if (field) showInput(field.field)
        return
      }

      // Log scroll
      if (input === 'k') {
        setScrollOffset((prev) => { const m = maxOffsetRef.current; return Math.max(0, (prev === -1 ? m : prev) - 1) })
        return
      }
      if (input === 'j') {
        setScrollOffset((prev) => { const m = maxOffsetRef.current; const c = prev === -1 ? m : prev; const n = Math.min(m, c + 1); return n >= m ? -1 : n })
        return
      }
      if (input === 'g') { setScrollOffset(0); return }
      if (input === 'G') { setScrollOffset(-1); return }
      if (input === 'x') { clearLogs(); return }
    },
    { isActive: !isBlocked },
  )

  // Loading
  if (!config) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text dimColor> Loading...</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray">
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="cyan">Telebear</Text>
          <Text dimColor>SSH Tunnel</Text>
        </Box>
        {notification && (
          <Text color={notification.type === 'success' ? 'green' : notification.type === 'error' ? 'red' : 'blue'} bold>
            {notification.type === 'success' ? '[v]' : notification.type === 'error' ? '[x]' : '[i]'} {notification.message}
          </Text>
        )}
      </Box>

      <Box paddingX={1}><Text dimColor>{'─'.repeat(Math.max(0, cols - 4))}</Text></Box>

      {/* Top row: Services + Config (each subscribes to its own store slices) */}
      <Box paddingX={1} gap={1}>
        <ServicesPanel />
        <ConfigPanel />
      </Box>

      {/* Connection info */}
      {(sshPort || tunnelAddress) && (
        <Box paddingX={1}>
          <Box borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
            <Box gap={2}>
              {sshPort && (
                <Text><Text dimColor>Local: </Text><Text color="cyan">ssh -p {sshPort} user@127.0.0.1</Text></Text>
              )}
              {tunnelAddress && (
                <Text><Text dimColor>Remote: </Text><Text color="green">ssh -p {tunnelAddress.split(':').pop()} user@{config.frp.server_addr}</Text></Text>
              )}
            </Box>
          </Box>
        </Box>
      )}

      {/* Errors */}
      {lastError && (
        <Box paddingX={1}>
          <Box borderStyle="single" borderColor="red" paddingX={1} flexGrow={1}>
            <Text color="red">{lastError}</Text>
          </Box>
        </Box>
      )}
      {configErrors.length > 0 && !isRunning && !isStarting && (
        <Box paddingX={1}>
          <Box borderStyle="single" borderColor="yellow" paddingX={1} flexGrow={1} flexDirection="column">
            {configErrors.map((err, i) => <Text key={i} color="yellow">- {err}</Text>)}
          </Box>
        </Box>
      )}

      {/* Log (subscribes to logs internally, scroll state passed from keybinding handler) */}
      <Box paddingX={1}>
        <LogPanel effectiveOffset={effectiveOffset} isAtBottom={isAtBottom} />
      </Box>

      {/* Hint bar */}
      <Box paddingX={1} gap={1} flexWrap="wrap">
        <Text><Text bold color="yellow">s</Text><Text dimColor> {isRunning || isStarting ? 'Stop' : 'Start'}</Text></Text>
        {(isRunning || isStarting || isError) && (
          <Text><Text bold color="yellow">r</Text><Text dimColor> Restart</Text></Text>
        )}
        <Text><Text bold color="yellow">{'\u2191\u2193'}</Text><Text dimColor> Config</Text></Text>
        <Text><Text bold color="yellow">{'\u23CE'}</Text><Text dimColor> Edit</Text></Text>
        <Text><Text bold color="yellow">j/k</Text><Text dimColor> Log</Text></Text>
        <Text><Text bold color="yellow">x</Text><Text dimColor> Clear</Text></Text>
        <Text><Text bold color="yellow">q</Text><Text dimColor> Quit</Text></Text>
      </Box>

      {/* Overlays */}
      {confirmQuit && (
        <Box paddingX={1}>
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow" bold>Services running. Quit and stop all? (y/n)</Text>
          </Box>
        </Box>
      )}
      {inputDialog && (
        <Box paddingX={1}>
          <InputDialog
            key={inputDialog.title}
            title={inputDialog.title}
            placeholder={inputDialog.placeholder}
            defaultValue={inputDialog.defaultValue}
            multiline={inputDialog.multiline}
            onSubmit={(value) => { closeInput(); updateConfig(inputDialog.field, value) }}
            onCancel={closeInput}
          />
        </Box>
      )}
    </Box>
  )
}
