import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

interface InputDialogProps {
  title: string
  placeholder: string
  defaultValue?: string
  multiline?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function InputDialog({ title, placeholder, defaultValue = '', multiline = false, onSubmit, onCancel }: InputDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const [cursor, setCursor] = useState(defaultValue.length)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      if (multiline && !key.ctrl) {
        // In multiline mode, plain Enter inserts newline
        setValue(value.slice(0, cursor) + '\n' + value.slice(cursor))
        setCursor(cursor + 1)
        return
      }
      // Single-line Enter or Ctrl+Enter in multiline → submit
      onSubmit(value)
      return
    }
    // Ctrl+D to submit in multiline mode
    if (multiline && key.ctrl && input === 'd') {
      onSubmit(value)
      return
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
      }
      return
    }
    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(Math.min(value.length, cursor + 1))
      return
    }
    if (input && !key.ctrl && !key.meta) {
      setValue(value.slice(0, cursor) + input + value.slice(cursor))
      setCursor(cursor + input.length)
    }
  })

  // For multiline, render lines with cursor
  if (multiline) {
    const lines = value.split('\n')
    let charCount = 0
    const renderedLines = lines.map((line, lineIdx) => {
      const lineStart = charCount
      charCount += line.length + 1 // +1 for \n
      const cursorInLine = cursor >= lineStart && cursor <= lineStart + line.length
      const localCursor = cursor - lineStart

      if (!value && lineIdx === 0) {
        // Show placeholder
        return (
          <Box key={lineIdx}>
            <Text inverse> </Text>
            <Text dimColor>{placeholder}</Text>
          </Box>
        )
      }

      if (cursorInLine) {
        return (
          <Text key={lineIdx}>
            {line.slice(0, localCursor)}
            <Text inverse>{line[localCursor] ?? ' '}</Text>
            {line.slice(localCursor + 1)}
          </Text>
        )
      }
      return <Text key={lineIdx}>{line || ' '}</Text>
    })

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          {title}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {renderedLines}
        </Box>
        <Box marginTop={1} gap={2}>
          <Text dimColor>
            <Text bold color="yellow">{'\u23CE'}</Text> newline
          </Text>
          <Text dimColor>
            <Text bold color="yellow">^D</Text> confirm
          </Text>
          <Text dimColor>
            <Text bold color="yellow">{'\u238B'}</Text> cancel
          </Text>
        </Box>
      </Box>
    )
  }

  // Single-line mode (original behavior)
  const displayValue = value || placeholder
  const isPlaceholder = !value

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <Box marginTop={1}>
        <Text dimColor={isPlaceholder}>
          {displayValue.slice(0, cursor)}
        </Text>
        <Text inverse>{displayValue[cursor] ?? ' '}</Text>
        <Text dimColor={isPlaceholder}>
          {displayValue.slice(cursor + 1)}
        </Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text dimColor>
          <Text bold color="yellow">
            {'\u23CE'}
          </Text>{' '}
          confirm
        </Text>
        <Text dimColor>
          <Text bold color="yellow">
            {'\u238B'}
          </Text>{' '}
          cancel
        </Text>
      </Box>
    </Box>
  )
}
