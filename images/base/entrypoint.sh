#!/bin/sh
# Ionnet GSM instance entrypoint. The agent starts the container with `sh -c "<startup>"`; the
# server has already substituted the template's variables, but any {{NAME}} left in the command
# (a custom template referencing a runtime-only value) is filled from the environment here.
set -u
cd /data 2>/dev/null || true

if [ "$#" -ge 3 ] && [ "$1" = "sh" ] && [ "$2" = "-c" ]; then
  cmd="$3"
  for name in $(printf '%s' "$cmd" | grep -o '{{[A-Z][A-Z0-9_]*}}' | tr -d '{}' | sort -u); do
    eval "val=\${$name:-}"
    cmd=$(printf '%s' "$cmd" | awk -v n="{{$name}}" -v v="$val" '{
      i = index($0, n)
      while (i) { $0 = substr($0, 1, i - 1) v substr($0, i + length(n)); i = index($0, n) }
      print
    }')
  done
  echo "[GSM] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting: $cmd"
  exec sh -c "$cmd"
fi

echo "[GSM] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting: $*"
exec "$@"
