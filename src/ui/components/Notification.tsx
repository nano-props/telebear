import React from 'react'
import { Text } from 'ink'

interface NotificationProps {
  type: 'success' | 'error' | 'info'
  message: string
}

export function Notification({ type, message }: NotificationProps) {
  const color = type === 'success' ? 'green' : type === 'error' ? 'red' : 'blue'
  const icon = type === 'success' ? 'v' : type === 'error' ? 'x' : 'i'
  return (
    <Text color={color} bold>
      [{icon}] {message}
    </Text>
  )
}
