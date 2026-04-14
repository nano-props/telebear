import React from 'react'
import { Box, Text } from 'ink'
import { useAppStore } from '@/store/useAppStore.ts'

export const LOG_LINES = 8

interface LogPanelProps {
  effectiveOffset: number
  isAtBottom: boolean
}

export function LogPanel({ effectiveOffset, isAtBottom }: LogPanelProps) {
  const logs = useAppStore((s) => s.logs)
  const visibleLogs = logs.slice(effectiveOffset, effectiveOffset + LOG_LINES)

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">Log</Text>
        <Box gap={1}>
          {!isAtBottom && <Text color="yellow">SCROLLED</Text>}
          <Text dimColor>{logs.length} lines</Text>
        </Box>
      </Box>
      <Box flexDirection="column" minHeight={LOG_LINES}>
        {visibleLogs.length === 0 ? (
          <Text dimColor>No logs yet. Press s to start.</Text>
        ) : (
          visibleLogs.map((line, i) => {
            let color: string | undefined
            if (line.includes('[sshd]')) color = 'cyan'
            else if (line.includes('[frpc]')) color = 'magenta'
            else if (/\b(error|failed|failure)\b/i.test(line)) color = 'red'
            return <Text key={effectiveOffset + i} color={color} wrap="truncate">{line}</Text>
          })
        )}
      </Box>
    </Box>
  )
}
