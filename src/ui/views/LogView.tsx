import React, { useState, useEffect } from 'react'
import { Box, Text, useInput } from 'ink'
import { useAppStore, selectIsInputBlocked } from '@/store/useAppStore.ts'
import { Hint } from '@/ui/components/Hint.tsx'

const VISIBLE_LINES = 16

export function LogView() {
  const logs = useAppStore((s) => s.logs)
  const isBlocked = useAppStore(selectIsInputBlocked)
  const [scrollOffset, setScrollOffset] = useState(-1) // -1 means auto-scroll (pinned to bottom)

  const maxOffset = Math.max(0, logs.length - VISIBLE_LINES)
  const effectiveOffset = scrollOffset === -1 ? maxOffset : Math.min(scrollOffset, maxOffset)

  // Reset to auto-scroll when logs are cleared
  useEffect(() => {
    if (logs.length === 0) setScrollOffset(-1)
  }, [logs.length])

  useInput(
    (_input, key) => {
      if (key.upArrow || _input === 'k') {
        setScrollOffset((prev) => {
          const current = prev === -1 ? maxOffset : prev
          return Math.max(0, current - 1)
        })
      }
      if (key.downArrow || _input === 'j') {
        setScrollOffset((prev) => {
          const current = prev === -1 ? maxOffset : prev
          const next = Math.min(maxOffset, current + 1)
          return next >= maxOffset ? -1 : next
        })
      }
      if (_input === 'g') {
        setScrollOffset(0)
      }
      if (_input === 'G') {
        setScrollOffset(-1)
      }
    },
    { isActive: !isBlocked },
  )

  const visibleLogs = logs.slice(effectiveOffset, effectiveOffset + VISIBLE_LINES)
  const isAtBottom = scrollOffset === -1

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
      >
        {/* Log header inside border */}
        <Box justifyContent="space-between">
          <Text bold color="cyan">Log</Text>
          <Box gap={1}>
            {!isAtBottom && <Text color="yellow">SCROLLED</Text>}
            <Text dimColor>{logs.length} lines</Text>
          </Box>
        </Box>

        {/* Log content */}
        <Box marginTop={1} flexDirection="column" minHeight={VISIBLE_LINES}>
          {visibleLogs.length === 0 ? (
            <Text dimColor>No logs yet. Start services to see output.</Text>
          ) : (
            visibleLogs.map((line, i) => {
              let color: string | undefined
              if (line.includes('[sshd]')) color = 'cyan'
              else if (line.includes('[frpc]')) color = 'magenta'
              else if (line.includes('error') || line.includes('failed')) color = 'red'

              return (
                <Text key={effectiveOffset + i} color={color} wrap="truncate">
                  {line}
                </Text>
              )
            })
          )}
        </Box>
      </Box>

      <Hint
        marginTop={1}
        keys={[
          { key: 'up', label: 'Up' },
          { key: 'down', label: 'Down' },
          { key: 'g/G', label: 'Top/Bottom' },
          { key: 'esc', label: 'Back' },
          { key: 'x', label: 'Clear' },
        ]}
      />
    </Box>
  )
}
