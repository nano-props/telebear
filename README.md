# Telebear

Temporary SSH server with FRP tunnel — managed from a terminal UI.

Spins up an SSH server (via [ssh2](https://github.com/mscdex/ssh2)) and tunnels it through [FRP](https://github.com/fatedier/frp) so it's reachable from the internet.

## Dependencies

- `frpc` — FRP client ([github.com/fatedier/frp](https://github.com/fatedier/frp))

Install with the included script: `./setup-frp.sh` (run `./setup-frp.sh -h` for options).

## Usage

```bash
bun install
bun run start
```

Build standalone binary:

```bash
bun run build
./dist/telebear
```

Run `telebear --help` for keybindings and usage details.
