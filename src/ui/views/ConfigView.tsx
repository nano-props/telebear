import React from 'react'
import { Box, Text, useInput } from 'ink'
import { useAppStore, CONFIG_FIELDS, selectIsInputBlocked } from '@/store/useAppStore.ts'
import { Hint } from '@/ui/components/Hint.tsx'

const SSH_FIELDS = CONFIG_FIELDS.filter((f) => f.field.startsWith('ssh.'))
const FRP_FIELDS = CONFIG_FIELDS.filter((f) => f.field.startsWith('frp.'))

export function ConfigView() {
  const config = useAppStore((s) => s.config)
  const selectedConfigIndex = useAppStore((s) => s.selectedConfigIndex)
  const moveConfigSelection = useAppStore((s) => s.moveConfigSelection)
  const showInput = useAppStore((s) => s.showInput)
  const isBlocked = useAppStore(selectIsInputBlocked)

  useInput(
    (_input, key) => {
      if (key.upArrow) moveConfigSelection(-1)
      if (key.downArrow) moveConfigSelection(1)
      if (key.return) {
        const field = CONFIG_FIELDS[selectedConfigIndex]
        if (field) showInput(field.field)
      }
    },
    { isActive: !isBlocked },
  )

  if (!config) return <Text dimColor>Loading config...</Text>

  function getFieldValue(field: string): string {
    if (!config) return ''
    switch (field) {
      case 'ssh.authorized_keys': {
        const keys = config.ssh.authorized_keys
        if (keys.length === 0) return '(none)'
        return keys.length === 1 ? truncateKey(keys[0]!) : `${keys.length} keys`
      }
      case 'ssh.port':
        return String(config.ssh.port)
      case 'frp.server_addr':
        return config.frp.server_addr || '(not set)'
      case 'frp.server_port':
        return String(config.frp.server_port)
      case 'frp.token':
        return config.frp.token ? maskToken(config.frp.token) : '(not set)'
      case 'frp.remote_port':
        return config.frp.remote_port > 0 ? String(config.frp.remote_port) : '(not set)'
      default:
        return ''
    }
  }

  function renderField(f: (typeof CONFIG_FIELDS)[number], globalIndex: number) {
    const selected = globalIndex === selectedConfigIndex
    const value = getFieldValue(f.field)
    return (
      <Box key={f.field}>
        <Text color={selected ? 'cyan' : undefined} bold={selected}>
          {selected ? '> ' : '  '}
          {f.label}:{' '}
        </Text>
        <Text dimColor={!selected}>{value}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>~/.config/telebear/telebear.toml</Text>

      <Box gap={1} marginTop={1}>
        {/* SSH section */}
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} minWidth={30}>
          <Text bold color="cyan">SSH</Text>
          <Box flexDirection="column" marginTop={1}>
            {SSH_FIELDS.map((f) => {
              const globalIndex = CONFIG_FIELDS.indexOf(f)
              return renderField(f, globalIndex)
            })}
          </Box>
        </Box>

        {/* FRP section */}
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
          <Text bold color="cyan">FRP</Text>
          <Box flexDirection="column" marginTop={1}>
            {FRP_FIELDS.map((f) => {
              const globalIndex = CONFIG_FIELDS.indexOf(f)
              return renderField(f, globalIndex)
            })}
          </Box>
        </Box>
      </Box>

      <Hint
        marginTop={1}
        keys={[
          { key: 'up', label: 'Up' },
          { key: 'down', label: 'Down' },
          { key: 'enter', label: 'Edit' },
          { key: 's', label: 'Start/Stop' },
          { key: 'esc', label: 'Back' },
        ]}
      />
    </Box>
  )
}

function truncateKey(key: string): string {
  if (key.length <= 40) return key
  return key.slice(0, 20) + '...' + key.slice(-15)
}

function maskToken(token: string): string {
  if (token.length <= 4) return '****'
  return token.slice(0, 2) + '*'.repeat(Math.min(token.length - 4, 16)) + token.slice(-2)
}
