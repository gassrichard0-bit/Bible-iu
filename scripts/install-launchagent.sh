#!/bin/bash
# Bible IU backend autostart installer.
#
# Idempotent. Re-run any time backend/.env changes (key rotation) or
# after a fresh clone. Builds a venv against homebrew python3.12,
# installs the runtime deps the backend imports, and writes a fully
# rendered LaunchAgent plist to ~/Library/LaunchAgents/, then loads it.
#
# Why homebrew python3.12 and not the CommandLineTools Python 3.9 that
# the dev shell uses: on macOS Sonoma+, launchd-spawned binaries can
# only read ~/Desktop/ if they hold `kTCCServiceSystemPolicyDesktopFolder`.
# Full Disk Access does NOT cover Desktop in this context — granting
# FDA to CommandLineTools Python lands in the TCC db but still trips
# EPERM on every Desktop scandir from launchd. Homebrew python3.12
# already has the Desktop Folder grant from prior Terminal use, and a
# venv whose bin/python is a symlink to it inherits that grant.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/backend/.env"
VENV_DIR="$HOME/Library/Application Support/bible-iu/venv"
PLIST_DEST="$HOME/Library/LaunchAgents/com.user.bible-iu-backend.plist"
PLIST_LABEL="com.user.bible-iu-backend"
TEMPLATE="$REPO_DIR/scripts/com.user.bible-iu-backend.plist.template"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE missing — populate backend/.env first." >&2
  exit 1
fi
if [[ ! -x /opt/homebrew/bin/python3.12 ]]; then
  echo "ERROR: homebrew python3.12 not installed. Run: brew install python@3.12" >&2
  exit 1
fi

echo "[1/4] venv at $VENV_DIR"
mkdir -p "$(dirname "$VENV_DIR")"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  /opt/homebrew/bin/python3.12 -m venv "$VENV_DIR"
fi

echo "[2/4] installing/upgrading runtime deps"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
# Mirror backend/pyproject.toml plus runtime extras the pyproject doesn't
# list (multipart for form uploads, redis for chat fanout, pywebpush
# for VAPID, transformers for the DeBERTa verifier).
#
# REDIS_URL is read from backend/.env if present; otherwise the plist's
# default points at the local redis://127.0.0.1:6379/0 which we expect
# from `brew services start redis`. With 4 workers, redis is required —
# without it chat broadcasts won't fan out across worker processes.
"$VENV_DIR/bin/pip" install --quiet \
  "fastapi>=0.110" \
  "uvicorn[standard]>=0.27" \
  "pydantic>=2.6" \
  "sqlalchemy>=2.0" \
  "httpx>=0.27" \
  "websockets>=12.0" \
  "argon2-cffi>=23.1" \
  "pycrdt>=0.13" \
  "pycrdt-websocket>=0.16" \
  "alembic>=1.13" \
  "redis>=5" \
  "pywebpush>=2.0" \
  "transformers" \
  "torch" \
  "python-multipart" \
  "email-validator" \
  "Pillow"

echo "[3/4] rendering plist from template"
# Build the EnvironmentVariables block as XML key/string pairs by
# parsing backend/.env. Each line: KEY=VALUE, with VALUE optionally
# double-quoted across multiple lines (VAPID_PRIVATE_KEY).
render_env_xml() {
  local key value in_quote=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Skip blanks and comments at the top level.
    if (( in_quote == 0 )); then
      [[ -z "${line// /}" ]] && continue
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      key="${line%%=*}"
      rest="${line#*=}"
      if [[ "$rest" == \"* ]]; then
        # Starts with a quote — multi-line possible.
        rest="${rest#\"}"
        if [[ "$rest" == *\" ]]; then
          value="${rest%\"}"
        else
          value="$rest"
          in_quote=1
          continue
        fi
      else
        value="$rest"
      fi
    else
      # Continuing a quoted multi-line value.
      if [[ "$line" == *\" ]]; then
        value+=$'\n'"${line%\"}"
        in_quote=0
      else
        value+=$'\n'"$line"
        continue
      fi
    fi
    # XML-escape & < > in the value (no & or < in our env, but be safe).
    value="${value//&/&amp;}"
    value="${value//</&lt;}"
    value="${value//>/&gt;}"
    printf '    <key>%s</key>\n    <string>%s</string>\n' "$key" "$value"
  done < "$ENV_FILE"
}

ENV_XML="$(render_env_xml)"
# Substitute placeholders. Use python for the env-vars chunk because
# it contains newlines that confuse sed.
"$VENV_DIR/bin/python" - "$TEMPLATE" "$VENV_DIR/bin/python" "$REPO_DIR" "$HOME" "$USER" "$ENV_XML" > "$PLIST_DEST" <<'PY'
import sys
template_path, venv_python, repo_dir, home, user, env_xml = sys.argv[1:7]
with open(template_path) as f:
    content = f.read()
content = (
    content
    .replace("@VENV_PYTHON@", venv_python)
    .replace("@REPO_DIR@", repo_dir)
    .replace("@HOME@", home)
    .replace("@USER@", user)
    .replace("@ENV_VARS@", env_xml)
)
sys.stdout.write(content)
PY

plutil -lint "$PLIST_DEST" >/dev/null

echo "[4/4] reloading launchd"
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

# Wait up to 15s for the port to come up.
for i in $(seq 1 30); do
  sleep 0.5
  if curl -fsS -o /dev/null http://127.0.0.1:8765/health 2>/dev/null; then
    echo "✓ backend up — $(curl -sS http://127.0.0.1:8765/healthz)"
    exit 0
  fi
done

echo "ERROR: backend did not come up. Last 20 lines of /tmp/bible-iu-backend.log:" >&2
tail -20 /tmp/bible-iu-backend.log >&2 || true
exit 1
