import React from 'react'
import { Text, Box } from 'ink'

export interface HintKey {
  key: string
  label: string
}

const KEY_SYMBOLS: Record<string, string> = {
  enter: '\u23CE',
  return: '\u23CE',
  tab: '\u21E5',
  esc: '\u238B',
  escape: '\u238B',
  up: '\u2191',
  down: '\u2193',
  left: '\u2190',
  right: '\u2192',
}

interface HintProps {
  keys: HintKey[]
  marginTop?: number
}

export function Hint({ keys, marginTop = 0 }: HintProps) {
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      <Box gap={1} flexWrap="wrap">
        {keys.map(({ key, label }, i) => {
          const symbol = KEY_SYMBOLS[key] ?? KEY_SYMBOLS[key.toLowerCase()] ?? key
          return (
            <Box key={i}>
              <Text bold color="yellow">
                {symbol}
              </Text>
              <Text dimColor> {label}</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
