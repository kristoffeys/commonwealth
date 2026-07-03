#!/bin/sh
# Put the `commonwealth` CLI on your PATH before npm publish (#49).
#
# Writes a tiny wrapper to ~/.local/bin/commonwealth that execs the built CLI from THIS repo.
# A wrapper (not a symlink) so it survives `pnpm build` regardless of the dist file's exec bit.
# Idempotent: re-run any time (e.g. after moving the repo) to repoint the wrapper.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cli="$repo_root/packages/cli/dist/index.js"

if [ ! -f "$cli" ]; then
  echo "error: $cli not found — run 'pnpm build' first." >&2
  exit 1
fi

bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
target="$bin_dir/commonwealth"
mkdir -p "$bin_dir"

printf '#!/bin/sh\n# Commonwealth CLI wrapper → runs the built CLI from the local repo (pre-npm-publish, #49).\nexec node "%s" "$@"\n' "$cli" > "$target"
chmod +x "$target"

echo "linked: $target → $cli"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: $bin_dir is not on your PATH — add it, e.g.: export PATH=\"$bin_dir:\$PATH\"" >&2 ;;
esac
