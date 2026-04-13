import React, { useState, useEffect } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import Spinner from 'ink-spinner'
import { useAppStore, selectIsInputBlocked } from '@/store/useAppStore.ts'
import { StatusView } from '@/ui/views/StatusView.tsx'
import { ConfigView } from '@/ui/views/ConfigView.tsx'
import { LogView } from '@/ui/views/LogView.tsx'
import { Notification } from '@/ui/components/Notification.tsx'
import { InputDialog } from '@/ui/components/InputDialog.tsx'

const MIN_COLS = 60
const MIN_ROWS = 15

function useTerminalSize() {
  const [size, setSize] = useState({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  })
  useEffect(() => {
    const onResize = () => setSize({ cols: process.stdout.columns, rows: process.stdout.rows })
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
    }
  }, [])
  return size
}

export function App() {
  const { exit } = useApp()
  const { cols, rows } = useTerminalSize()
  const tooSmall = cols < MIN_COLS || rows < MIN_ROWS

  useInput(
    (input) => {
      if (input === 'q') exit()
    },
    { isActive: tooSmall },
  )

  if (tooSmall) {
    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <Text color="yellow">Terminal too small</Text>
        <Text dimColor>
          Need at least {MIN_COLS}x{MIN_ROWS}, current {cols}x{rows}
        </Text>
        <Text dimColor>Resize your terminal or press q to quit</Text>
      </Box>
    )
  }

  return <AppMain />
}

function AppMain() {
  const { exit } = useApp()
  const currentView = useAppStore((s) => s.currentView)
  const notification = useAppStore((s) => s.notification)
  const inputDialog = useAppStore((s) => s.inputDialog)
  const confirmQuit = useAppStore((s) => s.confirmQuit)
  const init = useAppStore((s) => s.init)
  const setCurrentView = useAppStore((s) => s.setCurrentView)
  const startServices = useAppStore((s) => s.startServices)
  const stopServices = useAppStore((s) => s.stopServices)
  const restartServices = useAppStore((s) => s.restartServices)
  const closeInput = useAppStore((s) => s.closeInput)
  const updateConfig = useAppStore((s) => s.updateConfig)
  const clearLogs = useAppStore((s) => s.clearLogs)
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit)
  const config = useAppStore((s) => s.config)
  const sshStatus = useAppStore((s) => s.sshStatus)
  const frpcStatus = useAppStore((s) => s.frpcStatus)

  const isBlocked = useAppStore(selectIsInputBlocked)
  const isRunning = sshStatus === 'running' || frpcStatus === 'running'
  const isStarting = sshStatus === 'starting' || frpcStatus === 'starting'

  // Init on mount
  useEffect(() => {
    init()
  }, [])

  // Confirm quit keybindings
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') {
        stopServices().then(() => exit())
        return
      }
      // Any other key cancels
      setConfirmQuit(false)
    },
    { isActive: confirmQuit },
  )

  // Global keybindings
  useInput(
    (input, key) => {
      if (input === 'q') {
        if (isRunning || isStarting) {
          setConfirmQuit(true)
        } else {
          exit()
        }
        return
      }

      // View navigation
      if (key.escape) {
        setCurrentView('status')
        return
      }
      if (input === 'c') {
        setCurrentView('config')
        return
      }
      if (input === 'l') {
        setCurrentView('log')
        return
      }

      // Service control (global)
      if (input === 's') {
        if (isRunning || isStarting) {
          stopServices()
        } else {
          startServices()
        }
        return
      }

      // Restart services
      if (input === 'r' && (isRunning || isStarting)) {
        restartServices()
        return
      }

      // Number key navigation
      if (input === '1') {
        setCurrentView('status')
        return
      }
      if (input === '2') {
        setCurrentView('config')
        return
      }
      if (input === '3') {
        setCurrentView('log')
        return
      }

      // Log clear
      if (input === 'x' && currentView === 'log') {
        clearLogs()
      }
    },
    { isActive: !isBlocked },
  )

  const renderView = () => {
    switch (currentView) {
      case 'status':
        return <StatusView />
      case 'config':
        return <ConfigView />
      case 'log':
        return <LogView />
    }
  }

  // Tab labels
  const tabs: { key: string; label: string; view: typeof currentView }[] = [
    { key: '1', label: 'Status', view: 'status' },
    { key: '2', label: 'Config', view: 'config' },
    { key: '3', label: 'Log', view: 'log' },
  ]

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray">
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="cyan">
            Telebear
          </Text>
          <Text dimColor>SSH Tunnel</Text>
          <Text dimColor>|</Text>
          {tabs.map((t) => (
            <Text
              key={t.key}
              bold={currentView === t.view}
              color={currentView === t.view ? 'cyan' : undefined}
              dimColor={currentView !== t.view}
            >
              {t.key}:{t.label}
            </Text>
          ))}
        </Box>
        {notification ? <Notification type={notification.type} message={notification.message} /> : null}
      </Box>

      {/* Separator */}
      <Box paddingX={1}>
        <Text dimColor>{'─'.repeat(Math.max(0, (process.stdout.columns ?? 80) - 4))}</Text>
      </Box>

      {/* Main View */}
      <Box>
        {!config ? (
          <Box paddingX={2}>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text dimColor> Loading...</Text>
          </Box>
        ) : (
          renderView()
        )}
      </Box>

      {/* Quit Confirmation */}
      {confirmQuit && (
        <Box paddingX={1}>
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow" bold>
              Services are running. Quit and stop all services? (y/n)
            </Text>
          </Box>
        </Box>
      )}

      {/* Input Dialog */}
      {inputDialog && (
        <Box paddingX={1}>
          <InputDialog
            key={inputDialog.title}
            title={inputDialog.title}
            placeholder={inputDialog.placeholder}
            defaultValue={inputDialog.defaultValue}
            multiline={inputDialog.multiline}
            onSubmit={(value) => {
              closeInput()
              updateConfig(inputDialog.field, value)
            }}
            onCancel={closeInput}
          />
        </Box>
      )}
    </Box>
  )
}
