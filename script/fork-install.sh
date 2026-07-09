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

# Bake a real channel + version (fork issue session-umbrella/08). Outside
# release CI, Script.channel falls back to `git branch --show-current`, which
# is empty in a colocated jj checkout — the compiled binary then selects a
# fresh `opencode-.db` and reports version `0.0.0--<ts>`, whose
# `@opencode-ai/plugin@0.0.0--<ts>` pin breaks daemon tool provisioning.
# `prod` is what upstream stable releases bake (real `opencode.db`, inert
# update check: npm has no `prod` dist-tag). The version must be a published
# @opencode-ai/plugin version for the pin to resolve, so use the workspace
# version — it identifies the upstream base the fork was built from.
version="$(bun -e 'console.log((await Bun.file("packages/opencode/package.json").json()).version)')"
export OPENCODE_CHANNEL=prod
export OPENCODE_VERSION="$version"

bun install
./packages/opencode/script/build.ts --single

# smoke: channel/version actually baked (regression: empty-channel db + bogus version)
binary="packages/opencode/dist/opencode-${platform}/bin/opencode"
built_version="$("$binary" --version)"
[ "$built_version" = "$version" ] || { echo "smoke failed: version '$built_version' != '$version'" >&2; exit 1; }
db_path="$("$binary" db path)"
[ "$(basename "$db_path")" = "opencode.db" ] || { echo "smoke failed: db path '$db_path' is not opencode.db" >&2; exit 1; }

mkdir -p "$(dirname "$dest")"
install -m 755 "$binary" "$dest"
echo "installed $("$dest" --version) (channel prod, db $db_path) -> $dest"
echo
echo "next steps (once, when switching off brew):"
echo "  brew uninstall opencode          # never PATH-shadow a stale binary"
echo "  edit ~/dotfiles/LaunchAgents/com.murtaza.opencode-server.plist:"
echo "    /opt/homebrew/bin/opencode -> $dest"
echo "then (every install):"
echo "  launchctl kickstart -k gui/\$UID/com.murtaza.opencode-server"
