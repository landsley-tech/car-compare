#!/bin/bash
# Installs (or updates) Car Compare as a sandboxed systemd service. Run from a clone: sudo bash deploy/install.sh
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
repo=$(dirname "$here")
install -d -m 755 /opt/car-compare
cp -r "$repo"/{server.py,web} /opt/car-compare/
# the database isn't in git (licensing); without it the app uses Featured + EPA only
if [ -f "$repo/data/cars.db" ]; then cp -r "$repo/data" /opt/car-compare/
else echo "No data/cars.db: build it with tools/build_db.py for the Full database"; fi
chmod -R a+rX,go-w /opt/car-compare          # the throwaway service user must be able to read, never write
install -m 644 "$here/car-compare.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable car-compare
systemctl restart car-compare
if ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow from 192.168.0.0/24 to any port 8000 proto tcp
  ufw allow in on tailscale0 to any port 8000 proto tcp
fi
sleep 1
systemctl is-active car-compare && curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8000/
