#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { App } from '@/ui/App.tsx'
import { cleanupServices } from '@/store/useAppStore.ts'

const VERSION = '0.1.0'
const DESCRIPTION = 'Temporary SSH server with FRP tunnel'

function isInteractiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb')
}

function formatFatalError(error: unknown) {
  if (error instanceof Error) {
    return {
      exitCode: 1,
      message: `${error.stack ?? error.message}\n`,
    }
  }
  return {
    exitCode: 1,
    message: `${String(error)}\n`,
  }
}

const arg = process.argv[2]

if (arg === '-v' || arg === '--version') {
  console.log(`telebear ${VERSION}`)
  process.exit(0)
}

if (arg === '-h' || arg === '--help') {
  console.log(`telebear ${VERSION} - ${DESCRIPTION}

Usage: telebear [options]

Options:
  -v, --version  Show version
  -h, --help     Show this help

Dependencies:
  frpc           FRP client (github.com/fatedier/frp)

Keys:
  s              Start/Stop services
  r              Restart services
  Up/Down        Navigate config fields
  Enter          Edit selected field
  j/k            Scroll log
  g / G          Jump to top / bottom of log
  x              Clear log
  q              Quit

Config: ~/.config/telebear/telebear.toml`)
  process.exit(0)
}

if (!isInteractiveTerminal()) {
  process.stderr.write('telebear requires an interactive terminal (TTY).\n')
  process.exit(1)
}

// Alternate screen buffer (fullscreen)
process.stdout.write(
  '\x1b[?1049h' + // enter alternate screen
    '\x1b[H' + // cursor to top-left
    '\x1b[2J' + // clear entire screen
    '\x1b]0;Telebear\x07', // terminal title
)

let restored = false
function restoreTerminal() {
  if (restored) return
  restored = true
  cleanupServices()
  process.stdout.write('\x1b[?1049l') // leave alternate screen
}

function exitWithError(error: unknown): never {
  restoreTerminal()
  const fatal = formatFatalError(error)
  process.stderr.write(fatal.message)
  process.exit(fatal.exitCode)
}

process.once('exit', restoreTerminal)
process.once('SIGINT', () => {
  restoreTerminal()
  process.exit(130)
})
process.once('SIGTERM', () => {
  restoreTerminal()
  process.exit(143)
})
process.once('uncaughtException', exitWithError)
process.once('unhandledRejection', exitWithError)

async function main() {
  const app = render(React.createElement(App))
  await app.waitUntilExit()
}

void main().catch(exitWithError)
