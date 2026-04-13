#!/bin/bash
# One-time (idempotent) setup for the music recognition backend on armanserver.
# Installs ffmpeg + a Python venv, pip installs ShazamIO, installs a systemd
# unit, and starts the service on 127.0.0.1:8765.
#
# After this script succeeds, you still need to add the nginx location block
# manually (see README comment at the bottom).
set -euo pipefail

APP_DIR="/home/azureuser/telegram-management-bots/tasks/music_player_app"
VENV_DIR="$APP_DIR/recognize_venv"
SERVICE_FILE="/etc/systemd/system/recognize.service"

echo "==> Installing system deps (ffmpeg, python3-venv)"
if ! command -v ffmpeg >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y ffmpeg python3-venv
else
    echo "    ffmpeg already installed"
fi

echo "==> Creating Python venv at $VENV_DIR"
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi

echo "==> Installing Python deps"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$APP_DIR/recognize_requirements.txt"

echo "==> Installing systemd unit"
sudo cp "$APP_DIR/recognize.service" "$SERVICE_FILE"
sudo systemctl daemon-reload
sudo systemctl enable recognize
sudo systemctl restart recognize
sleep 1
sudo systemctl --no-pager status recognize | head -15 || true

echo ""
echo "==> Health check"
curl -sS http://127.0.0.1:8765/api/recognize/health && echo "" || echo "(health check failed)"

cat <<'EOF'

Done. Next, add this location block to your nginx site config
(probably /etc/nginx/sites-enabled/default) above `location / {`:

    location /api/recognize {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 6M;
        proxy_connect_timeout 30s;
        proxy_read_timeout 60s;
    }

Then: sudo nginx -t && sudo systemctl reload nginx
EOF
