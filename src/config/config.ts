import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, chmod } from 'node:fs/promises'
import { stringify } from 'smol-toml'
import { z } from 'zod'

const sshSchema = z.object({
  authorized_keys: z.union([z.array(z.string()), z.string().transform((s) => [s])]).default([]),
  port: z.number().int().positive().default(20222),
})

const frpSchema = z.object({
  server_addr: z.string().default(''),
  server_port: z.number().int().positive().default(7000),
  token: z.string().default(''),
  remote_port: z.number().int().nonnegative().default(0),
})

const configSchema = z.object({
  ssh: sshSchema.default({ authorized_keys: [], port: 20222 }),
  frp: frpSchema.default({ server_addr: '', server_port: 7000, token: '', remote_port: 0 }),
})

export type TelebearConfig = z.infer<typeof configSchema>

const CONFIG_DIR = join(homedir(), '.config', 'telebear')
const CONFIG_FILE = join(CONFIG_DIR, 'telebear.toml')

export const HOST_KEY_PATH = join(CONFIG_DIR, 'ssh_host_ed25519_key')
export const AUTHORIZED_KEYS_PATH = join(CONFIG_DIR, 'authorized_keys')

export function defaultConfig(): TelebearConfig {
  return configSchema.parse({})
}

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
}

export interface LoadConfigResult {
  ok: boolean
  config: TelebearConfig
  error?: string
}

export async function loadConfig(): Promise<LoadConfigResult> {
  await ensureConfigDir()
  try {
    const file = Bun.file(CONFIG_FILE)
    if (!(await file.exists())) {
      return { ok: true, config: defaultConfig() }
    }
    const content = await file.text()
    const raw = Bun.TOML.parse(content)
    const config = configSchema.parse(raw)
    return { ok: true, config }
  } catch (err: unknown) {
    // Parse error or other I/O error — surface the message
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      config: defaultConfig(),
      error: `Failed to parse config: ${message}`,
    }
  }
}

export async function saveConfig(config: TelebearConfig): Promise<void> {
  await ensureConfigDir()
  const content = stringify(config as unknown as Record<string, unknown>)
  await Bun.write(CONFIG_FILE, content, { mode: 0o600 })
}

export async function writeAuthorizedKeys(keys: string[]): Promise<void> {
  await ensureConfigDir()
  await Bun.write(AUTHORIZED_KEYS_PATH, keys.join('\n') + '\n', { mode: 0o600 })
}

/** Ensure host key has correct permissions after generation. */
export async function ensureHostKeyPermissions(): Promise<void> {
  try {
    await chmod(HOST_KEY_PATH, 0o600)
  } catch {
    // Key may not exist yet — that's fine
  }
}

export function isConfigValid(config: TelebearConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (config.ssh.authorized_keys.length === 0) errors.push('No SSH public keys configured')
  if (!config.frp.server_addr) errors.push('FRP server address is empty')
  if (config.frp.server_port <= 0) errors.push('FRP server port is invalid')
  if (!config.frp.token) errors.push('FRP token is empty')
  if (config.frp.remote_port < 0 || config.frp.remote_port > 65535) errors.push('FRP remote port is invalid')
  return { valid: errors.length === 0, errors }
}
