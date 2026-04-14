import React from 'react'
import { Box, Text } from 'ink'
import { useAppStore, CONFIG_FIELDS } from '@/store/useAppStore.ts'
import type { TelebearConfig } from '@/config/config.ts'

const SSH_FIELDS = CONFIG_FIELDS.filter((f) => f.field.startsWith('ssh.'))
const FRP_FIELDS = CONFIG_FIELDS.filter((f) => f.field.startsWith('frp.'))

function truncateKey(key: string): string {
  if (key.length <= 36) return key
  return key.slice(0, 18) + '...' + key.slice(-12)
}

function maskToken(token: string): string {
  if (token.length <= 4) return '****'
  return token.slice(0, 2) + '*'.repeat(Math.min(token.length - 4, 12)) + token.slice(-2)
}

function getFieldValue(config: TelebearConfig, field: string): string {
  switch (field) {
    case 'ssh.authorized_keys': {
      const keys = config.ssh.authorized_keys
      if (keys.length === 0) return '(none)'
      return keys.length === 1 ? truncateKey(keys[0]!) : `${keys.length} keys`
    }
    case 'ssh.port': return String(config.ssh.port)
    case 'frp.server_addr': return config.frp.server_addr || '(not set)'
    case 'frp.server_port': return String(config.frp.server_port)
    case 'frp.token': return config.frp.token ? maskToken(config.frp.token) : '(not set)'
    case 'frp.remote_port': return config.frp.remote_port > 0 ? String(config.frp.remote_port) : `(= local ${config.ssh.port})`
    default: return ''
  }
}

export function ConfigPanel() {
  const config = useAppStore((s) => s.config)
  const selectedIndex = useAppStore((s) => s.selectedConfigIndex)

  if (!config) return null

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">Config</Text>
        <Text dimColor>~/.config/telebear/telebear.toml</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {CONFIG_FIELDS.map((f, i) => {
          const selected = i === selectedIndex
          const value = getFieldValue(config, f.field)
          const isFirstSsh = f === SSH_FIELDS[0]
          const isFirstFrp = f === FRP_FIELDS[0]
          return (
            <Box key={f.field} flexDirection="column">
              {isFirstSsh && <Text dimColor>  SSH</Text>}
              {isFirstFrp && <Text dimColor>  FRP</Text>}
              <Box>
                <Text color={selected ? 'cyan' : undefined} bold={selected}>
                  {selected ? '> ' : '  '}{f.label}:{' '}
                </Text>
                <Text dimColor={!selected}>{value}</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
