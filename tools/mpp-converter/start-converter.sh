#!/usr/bin/env sh
# Starts the local .mpp -> MS Project XML converter (server.py) on port ${MPP_PORT:-8787}.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
JDK="$HOME/android-toolchain/jdk17"
if [ -z "$JAVA_HOME" ] && { [ -x "$JDK/bin/java" ] || [ -f "$JDK/bin/java.exe" ]; }; then
  JAVA_HOME="$JDK"; export JAVA_HOME
fi
ENVFILE="$HERE/../../web/.env"
envval() { grep -E "^$1=" "$ENVFILE" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '\r"'; }
if [ -f "$ENVFILE" ]; then
  [ -n "$SUPABASE_URL" ] || SUPABASE_URL=$(envval VITE_SUPABASE_URL)
  [ -n "$SUPABASE_ANON_KEY" ] || SUPABASE_ANON_KEY=$(envval VITE_SUPABASE_ANON_KEY)
fi
export SUPABASE_URL SUPABASE_ANON_KEY
if [ -x "$HERE/.venv/bin/python" ]; then PY="$HERE/.venv/bin/python"; else PY="$HERE/.venv/Scripts/python.exe"; fi
if [ ! -e "$PY" ]; then echo "Python venv not found in $HERE/.venv - see README.md for setup." >&2; exit 1; fi
echo "JAVA_HOME=$JAVA_HOME"
echo "SUPABASE_URL=$SUPABASE_URL"
exec "$PY" "$HERE/server.py"
