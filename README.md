# Telebear

Temporary SSH server with FRP tunnel — managed from a terminal UI.

Spins up a [Dropbear](https://matt.ucc.asn.au/dropbear/dropbear.html) SSH server and tunnels it through [FRP](https://github.com/fatedier/frp) so it's reachable from the internet.

## Dependencies

- `dropbear` — lightweight SSH server (also provides `dropbearkey`)
- `frpc` — FRP client ([github.com/fatedier/frp](https://github.com/fatedier/frp))

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
