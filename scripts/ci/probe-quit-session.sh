set -eu
export HOME=$(mktemp -d) XDG_RUNTIME_DIR=$(mktemp -d) XDG_CURRENT_DESKTOP=GNOME
export XDG_CONFIG_HOME="$HOME/config" XDG_CACHE_HOME="$HOME/cache"
mkdir -p "$XDG_CACHE_HOME"
printf '%s\n' playtest | gnome-keyring-daemon --unlock --components=secrets >/dev/null
node "$@"
