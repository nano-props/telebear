import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import Spinner from 'ink-spinner'
import { useAppStore } from '@/store/useAppStore.ts'
import type { ServiceStatus } from '@/store/useAppStore.ts'

function StatusIcon({ status }: { status: ServiceStatus }) {
  if (status === 'starting') return <Text color="yellow"><Spinner type="dots" /></Text>
  const icon = { stopped: '\u25CB', running: '\u25CF', error: '\u2716' } as const
  const color = { stopped: 'gray', running: 'green', error: 'red' } as const
  return <Text color={color[status]}>{icon[status]}</Text>
}

function formatDuration(from: Date): string {
  const sec = Math.floor((Date.now() - from.getTime()) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m${sec % 60}s`
  const hr = Math.floor(min / 60)
  return `${hr}h${min % 60}m`
}

export function ServicesPanel() {
  const sshStatus = useAppStore((s) => s.sshStatus)
  const frpcStatus = useAppStore((s) => s.frpcStatus)
  const activeClients = useAppStore((s) => s.activeClients)
  const isRunning = sshStatus === 'running' || frpcStatus === 'running'

  // Tick to refresh durations
  const [, setTick] = useState(0)
  useEffect(() => {
    if (activeClients.length === 0) return
    const id = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(id)
  }, [activeClients.length])

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} minWidth={26}>
      <Text bold color="cyan">Services</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text><StatusIcon status={sshStatus} /> <Text bold>SSH</Text> <Text dimColor>{sshStatus}</Text></Text>
        <Text><StatusIcon status={frpcStatus} /> <Text bold>FRP</Text> <Text dimColor>{frpcStatus}</Text></Text>
      </Box>

      {isRunning && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Clients ({activeClients.length})</Text>
          {activeClients.length === 0 ? (
            <Text dimColor>  none</Text>
          ) : (
            activeClients.map((c, i) => (
              <Text key={i}>  <Text color="green">{'\u25CF'}</Text> <Text bold>{c.username}</Text> <Text dimColor>{formatDuration(c.connectedAt)}</Text></Text>
            ))
          )}
        </Box>
      )}
    </Box>
  )
}
