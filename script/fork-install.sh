#!/usr/bin/env bash
# Fork build + global install.
#
# HUMAN-GATED: only Murtaza runs this against the global install
# (~/.local/bin/opencode + the com.murtaza.opencode-server LaunchAgent).
# Agents verify with in-lane dev builds instead — see .editspace/AGENTS.md.
set -euo pipefail
cd "$(dirname "$0")/.."

platform="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/')"
dest="${OPENCODE_FORK_INSTALL_DEST:-$HOME/.local/bin/opencode}"

bun install
./packages/opencode/script/build.ts --single

mkdir -p "$(dirname "$dest")"
install -m 755 "packages/opencode/dist/opencode-${platform}/bin/opencode" "$dest"
echo "installed $("$dest" --version) -> $dest"
echo
echo "next steps (once, when switching off brew):"
echo "  brew uninstall opencode          # never PATH-shadow a stale binary"
echo "  edit ~/dotfiles/LaunchAgents/com.murtaza.opencode-server.plist:"
echo "    /opt/homebrew/bin/opencode -> $dest"
echo "then (every install):"
echo "  launchctl kickstart -k gui/\$UID/com.murtaza.opencode-server"
