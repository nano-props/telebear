import React from 'react'
import { Text } from 'ink'
import Spinner from 'ink-spinner'
import type { ServiceStatus } from '@/store/useAppStore.ts'

interface StatusBadgeProps {
  status: ServiceStatus
  label: string
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const colorMap: Record<ServiceStatus, string> = {
    stopped: 'gray',
    starting: 'yellow',
    running: 'green',
    error: 'red',
  }
  const iconMap: Record<ServiceStatus, string> = {
    stopped: '\u25CB',
    starting: '',
    running: '\u25CF',
    error: '\u2716',
  }

  return (
    <Text>
      {status === 'starting' ? (
        <Text color="yellow">
          <Spinner type="dots" />
        </Text>
      ) : (
        <Text color={colorMap[status]}>{iconMap[status]}</Text>
      )}{' '}
      <Text bold>{label}</Text>
      <Text dimColor> {status}</Text>
    </Text>
  )
}
