#!/usr/bin/env bash
set -euo pipefail

# Install frpc and frps to $HOME/.local/bin
# Supports Linux and macOS, amd64 and arm64
# Usage: ./setup-frp.sh [--version VERSION] [--dry-run] [--remove]

DEFAULT_FRP_VERSION="0.68.1"
FRP_VERSION=""
INSTALL_DIR="$HOME/.local/bin"
GITHUB_BASE="${FRP_GITHUB_BASE:-https://github.com/fatedier/frp/releases/download}"

DRY_RUN=false
REMOVE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      cat <<EOF
Usage: $0 [OPTIONS]

Install or remove frpc and frps binaries.

Options:
  -v, --version VERSION      Specify frp version (default: $DEFAULT_FRP_VERSION)
      --github-base URL      Override download base URL (default: GitHub releases)
                             Can also be set via FRP_GITHUB_BASE env var
  -n, --dry-run              Check without actually installing or removing
      --remove               Remove installed frpc and frps
  -h, --help                 Show this help message
EOF
      exit 0
      ;;
    --dry-run|-n)
      DRY_RUN=true
      shift
      ;;
    --version|-v)
      [[ -z "${2:-}" ]] && { echo "Error: --version requires a value"; exit 1; }
      FRP_VERSION="$2"
      shift 2
      ;;
    --github-base)
      [[ -z "${2:-}" ]] && { echo "Error: --github-base requires a value"; exit 1; }
      GITHUB_BASE="$2"
      shift 2
      ;;
    --remove)
      REMOVE=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--version VERSION] [--dry-run|-n] [--remove]"
      exit 1
      ;;
  esac
done

# Strip leading 'v' if provided (e.g. v0.68.1 -> 0.68.1)
FRP_VERSION="${FRP_VERSION#v}"
FRP_VERSION="${FRP_VERSION:-$DEFAULT_FRP_VERSION}"

log() { echo "[INFO] $*"; }
warn() { echo "[WARN] $*"; }
err() { echo "[ERROR] $*" >&2; exit 1; }

# Handle --remove
if $REMOVE; then
  FRPC="$INSTALL_DIR/frpc"
  FRPS="$INSTALL_DIR/frps"
  removed=0
  for bin in "$FRPC" "$FRPS"; do
    if [ -f "$bin" ]; then
      if $DRY_RUN; then
        log "[DRY RUN] Would remove $bin"
      else
        rm "$bin"
        log "Removed $bin"
      fi
      removed=$((removed + 1))
    else
      log "$(basename "$bin") not found at $bin, skipping."
    fi
  done
  if [ "$removed" -eq 0 ]; then
    log "Nothing to remove."
  fi
  exit 0
fi

# Detect OS
case "$(uname -s)" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)      err "Unsupported OS: $(uname -s). Only Linux and macOS are supported." ;;
esac

# Detect architecture
case "$(uname -m)" in
  x86_64)       ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)             err "Unsupported architecture: $(uname -m). Only amd64 and arm64 are supported." ;;
esac

log "Detected: ${OS}/${ARCH}"

# Check if already installed
FRPC="$INSTALL_DIR/frpc"
FRPS="$INSTALL_DIR/frps"

frpc_installed=false
frps_installed=false

if [ -x "$FRPC" ]; then
  installed_ver=$("$FRPC" --version 2>/dev/null || echo "unknown")
  if [ "$installed_ver" = "$FRP_VERSION" ]; then
    log "frpc $FRP_VERSION already installed, skipping."
    frpc_installed=true
  else
    log "frpc found but version is $installed_ver (want $FRP_VERSION), will upgrade."
  fi
fi

if [ -x "$FRPS" ]; then
  installed_ver=$("$FRPS" --version 2>/dev/null || echo "unknown")
  if [ "$installed_ver" = "$FRP_VERSION" ]; then
    log "frps $FRP_VERSION already installed, skipping."
    frps_installed=true
  else
    log "frps found but version is $installed_ver (want $FRP_VERSION), will upgrade."
  fi
fi

if $frpc_installed && $frps_installed; then
  log "Both frpc and frps $FRP_VERSION are already installed. Nothing to do."
  exit 0
fi

# Check download tool
if command -v curl &>/dev/null; then
  DOWNLOADER="curl"
elif command -v wget &>/dev/null; then
  DOWNLOADER="wget"
else
  err "Neither curl nor wget found. Please install one of them."
fi

ARCHIVE="frp_${FRP_VERSION}_${OS}_${ARCH}.tar.gz"
URL="${GITHUB_BASE}/v${FRP_VERSION}/${ARCHIVE}"

log "Archive: $ARCHIVE"
log "URL: $URL"
log "Install dir: $INSTALL_DIR"
log "Downloader: $DOWNLOADER"

if $DRY_RUN; then
  log "[DRY RUN] Would download $URL"
  log "[DRY RUN] Would extract frpc and frps to $INSTALL_DIR"
  if ! $frpc_installed; then
    log "[DRY RUN] Would install frpc"
  fi
  if ! $frps_installed; then
    log "[DRY RUN] Would install frps"
  fi

  # Verify URL is reachable
  log "[DRY RUN] Checking if download URL is reachable..."
  if [ "$DOWNLOADER" = "curl" ]; then
    if curl -fsSL --head "$URL" -o /dev/null 2>/dev/null; then
      log "[DRY RUN] URL is reachable. Installation would succeed."
    else
      err "URL is not reachable: $URL"
    fi
  else
    if wget --spider -q "$URL" 2>/dev/null; then
      log "[DRY RUN] URL is reachable. Installation would succeed."
    else
      err "URL is not reachable: $URL"
    fi
  fi
  exit 0
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download and extract
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

log "Downloading $URL ..."
if [ "$DOWNLOADER" = "curl" ]; then
  curl -fSL "$URL" -o "$TMPDIR/$ARCHIVE"
else
  wget -q "$URL" -O "$TMPDIR/$ARCHIVE"
fi

log "Extracting..."
tar -xzf "$TMPDIR/$ARCHIVE" -C "$TMPDIR"

EXTRACTED_DIR="$TMPDIR/frp_${FRP_VERSION}_${OS}_${ARCH}"

if ! $frpc_installed; then
  install -m 755 "$EXTRACTED_DIR/frpc" "$INSTALL_DIR/frpc"
  log "Installed frpc to $INSTALL_DIR/frpc"
fi

if ! $frps_installed; then
  install -m 755 "$EXTRACTED_DIR/frps" "$INSTALL_DIR/frps"
  log "Installed frps to $INSTALL_DIR/frps"
fi

log "Done! Make sure $INSTALL_DIR is in your PATH."
