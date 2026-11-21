set -eu
export HOME=$(mktemp -d) XDG_RUNTIME_DIR=$(mktemp -d) XDG_CURRENT_DESKTOP=GNOME
export XDG_CONFIG_HOME="$HOME/config" XDG_CACHE_HOME="$HOME/cache"
export XDG_DATA_HOME="$HOME/.local/share"
mkdir -p "$XDG_CACHE_HOME" "$XDG_DATA_HOME/keyrings" "$XDG_CONFIG_HOME"
printf '%s\n' playtest | gnome-keyring-daemon --unlock --components=secrets >/dev/null
gnome-keyring-daemon --start --components=secrets >/dev/null
node "$@"
