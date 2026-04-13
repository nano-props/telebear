import React from 'react'
import { Box, Text } from 'ink'
import { useAppStore } from '@/store/useAppStore.ts'
import { StatusBadge } from '@/ui/components/StatusBadge.tsx'
import { Hint } from '@/ui/components/Hint.tsx'

export function StatusView() {
  const sshStatus = useAppStore((s) => s.sshStatus)
  const frpcStatus = useAppStore((s) => s.frpcStatus)
  const sshPort = useAppStore((s) => s.sshPort)
  const tunnelAddress = useAppStore((s) => s.tunnelAddress)
  const config = useAppStore((s) => s.config)
  const configErrors = useAppStore((s) => s.configErrors)
  const lastError = useAppStore((s) => s.lastError)

  const isRunning = sshStatus === 'running' || frpcStatus === 'running'
  const isStarting = sshStatus === 'starting' || frpcStatus === 'starting'

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Services & Connection side by side */}
      <Box gap={1}>
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} minWidth={28}>
          <Text bold color="cyan">Services</Text>
          <Box flexDirection="column" marginTop={1}>
            <StatusBadge status={sshStatus} label="SSH Server" />
            <StatusBadge status={frpcStatus} label="FRP Client" />
          </Box>
        </Box>

        {(sshPort || tunnelAddress) && (
          <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
            <Text bold color="cyan">Connection</Text>
            <Box marginTop={1} flexDirection="column">
              {sshPort && (
                <Text>
                  <Text dimColor>Local:  </Text>
                  <Text color="cyan">ssh -p {sshPort} user@127.0.0.1</Text>
                </Text>
              )}
              {tunnelAddress && (
                <Text>
                  <Text dimColor>Remote: </Text>
                  <Text color="green">ssh -p {config?.frp.remote_port} user@{config?.frp.server_addr}</Text>
                </Text>
              )}
            </Box>
          </Box>
        )}
      </Box>

      {/* Last Error */}
      {lastError && (
        <Box flexDirection="column" borderStyle="single" borderColor="red" paddingX={1} marginTop={1}>
          <Text bold color="red">Error</Text>
          <Text color="red">{lastError}</Text>
          <Text dimColor>Check log for details (l)</Text>
        </Box>
      )}

      {/* Config Errors */}
      {configErrors.length > 0 && !isRunning && !isStarting && (
        <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginTop={1}>
          <Text bold color="yellow">Config Issues</Text>
          {configErrors.map((err, i) => (
            <Text key={i} color="yellow">
              - {err}
            </Text>
          ))}
          <Text dimColor>Press c to edit config</Text>
        </Box>
      )}

      {/* Hints */}
      <Hint
        marginTop={1}
        keys={[
          ...(isRunning || isStarting
            ? [{ key: 's', label: 'Stop' }, { key: 'r', label: 'Restart' }]
            : [{ key: 's', label: 'Start' }]),
          { key: 'c', label: 'Config' },
          { key: 'l', label: 'Log' },
          { key: 'q', label: 'Quit' },
        ]}
      />
    </Box>
  )
}
