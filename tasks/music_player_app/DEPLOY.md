# Music Player — production deployment checklist

This file lives in the repo (visible on GitHub). It documents what the server
needs in place for the webapp + CORS proxy + recognize service to run. The
operational runbook with copy-pastable commands is in `.claude/skills/deploy.md`
(local-only).

## Topology

```
   client browser ───TLS──► nginx :443 (telemusic.duckdns.org)
                              │
                              ├─► /              → static files in
                              │                    ~/telegram-management-bots/tasks/music_player_app/webapp/
                              │
                              ├─► /proxy?url=…   → corsproxy.service on 127.0.0.1:3001
                              │                    (Node /var/www/musicplayer/proxy.js, runs as www-data)
                              │
                              └─► /api/recognize, /api/now-playing
                                                  → recognize.service on 127.0.0.1:8765
                                                    (Python recognize_server.py, runs as music-svc)
```

## 0. Host-level hardening (one-time, do this before enabling any unit)

The May 6 incident on this box escalated from a sibling-project RCE
(Next.js CVE-2025-55182 on homecook-hub) to root compromise because
default Ubuntu cloud images ship with passwordless sudo for `ubuntu`.
Shut that path off before standing up the music services.

### 0.1 Drop passwordless sudo

```bash
sudo passwd ubuntu                # set a real password FIRST
sudo rm -f /etc/sudoers.d/90-cloud-init-users
sudo grep -RIn NOPASSWD /etc/sudoers /etc/sudoers.d/ || echo "clean"
echo 'ubuntu ALL=(ALL) ALL' | sudo tee /etc/sudoers.d/10-ubuntu-with-password
sudo chmod 440 /etc/sudoers.d/10-ubuntu-with-password
sudo visudo -c                    # must say "parsed OK"
```

Verify from a SECOND ssh session: `sudo -k && sudo whoami` should
prompt for the password before printing `root`.

### 0.2 Enable security-only auto-upgrades

```bash
sudo apt update
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # answer "Yes"
sudo systemctl enable --now unattended-upgrades.service
```

### 0.3 Create the `music-svc` service user (for recognize.service)

The CORS proxy already runs as `www-data` (system user, no shell, no
sudo — perfect). The recognize service needs its own locked-down user:

```bash
sudo useradd --system --create-home --home-dir /var/lib/music-svc \
    --shell /usr/sbin/nologin music-svc

# Repo + Python venv ownership for the music_player_app subtree only.
# The rest of telegram-management-bots/ stays owned by ubuntu — the
# music services only need read access to their subdirs.
sudo chown -R music-svc:music-svc \
    /home/ubuntu/telegram-management-bots/tasks/music_player_app/recognize_venv \
    /home/ubuntu/telegram-management-bots/tasks/music_player_app/recognize_server.py \
    /home/ubuntu/telegram-management-bots/tasks/music_player_app/recognize_requirements.txt
ls -ld /home/ubuntu       # expect drwx--x--x (traversable for music-svc)
```

## What needs to exist on the server

### 1. nginx site `/etc/nginx/sites-available/musicplayer`

Must contain a `location = /proxy` block that **enforces Origin / Referer** at
the edge (defence-in-depth with the Node check that runs after). Reference
snippet:

```nginx
map $http_origin $allow_origin {
    default 0;
    "https://telemusic.duckdns.org" 1;
}
map $http_referer $allow_referer {
    default 0;
    "~^https://telemusic\.duckdns\.org/" 1;
}

location = /proxy {
    if ($allow_origin = 0) { if ($allow_referer = 0) { return 403; } }
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Origin $http_origin;
    proxy_set_header Referer $http_referer;
    proxy_set_header X-App-Token $http_x_app_token;
}
```

### 2. corsproxy systemd unit `/etc/systemd/system/corsproxy.service`

```ini
[Unit]
Description=Music Player CORS proxy
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/musicplayer
ExecStart=/usr/bin/node /var/www/musicplayer/proxy.js
EnvironmentFile=/etc/musicplayer/corsproxy.env
Restart=on-failure
RestartSec=3

# --- Tier 1 sandboxing ---
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @debug @mount @cpu-emulation @obsolete @raw-io @swap @reboot @module
CapabilityBoundingSet=
AmbientCapabilities=
# MemoryDenyWriteExecute omitted — V8 JIT needs W+X pages.

[Install]
WantedBy=multi-user.target
```

The CORS proxy is the most exposed of the three services (it actively
makes outbound HTTP requests on behalf of the webapp). The sandbox
makes the worst-case escape minimal: even with full code-exec as
`www-data`, the attacker has no writable filesystem
(`ReadWritePaths=` is empty), no `/home` access, no `/dev`, no
namespaces, no privileged syscalls.

### 3. corsproxy env file `/etc/musicplayer/corsproxy.env` (mode 640, owned root:www-data)

```env
ALLOWED_ORIGIN=https://telemusic.duckdns.org
APP_TOKEN=<64-hex-char secret — must match what's baked into the deployed webapp bundle>
```

The proxy refuses to start if either is missing. `APP_TOKEN` is rotated on
every deploy; see the deploy skill for the rotation procedure.

### 4. recognize systemd unit `/etc/systemd/system/recognize.service`

```ini
[Unit]
Description=Music recognition service (ShazamIO backend)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=music-svc
Group=music-svc
WorkingDirectory=/home/ubuntu/telegram-management-bots/tasks/music_player_app
Environment=PYTHONUNBUFFERED=1
Environment=HOME=/var/lib/music-svc
ExecStart=/home/ubuntu/telegram-management-bots/tasks/music_player_app/recognize_venv/bin/python recognize_server.py
Restart=on-failure
RestartSec=3

# --- Tier 1 sandboxing ---
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=read-only
ReadWritePaths=/var/lib/music-svc
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources @debug @mount @cpu-emulation @obsolete @raw-io @swap @reboot @module
CapabilityBoundingSet=
AmbientCapabilities=
# MemoryDenyWriteExecute omitted — CPython + numpy/audio libs can JIT-allocate.

[Install]
WantedBy=multi-user.target
```

### 5. Python venv for the recognize service

```bash
cd /home/ubuntu/telegram-management-bots/tasks/music_player_app
sudo -u music-svc python3 -m venv recognize_venv
sudo -u music-svc HOME=/var/lib/music-svc \
    ./recognize_venv/bin/pip install -r recognize_requirements.txt
sudo chown -R music-svc:music-svc recognize_venv
```

### 6. Provider firewall + UFW

- Provider firewall: allow inbound 22/tcp from your IP only, 80/tcp + 443/tcp from `0.0.0.0/0`.
- UFW on the box: optional belt-and-suspenders. Same rules as the provider firewall if enabled.

## Verifying the Tier 1 hardening

After both units are running, run these. Each should return a clean signal.

```bash
# (a) Services run as non-privileged users.
systemctl show corsproxy recognize -p User -p AmbientCapabilities -p CapabilityBoundingSet
# Expect: User=www-data on corsproxy, User=music-svc on recognize,
# both capability lines empty.

# (b) NOPASSWD really is gone.
sudo grep -RIn NOPASSWD /etc/sudoers /etc/sudoers.d/   # expect: no output
sudo -k && sudo whoami    # expect: prompts for ubuntu's password

# (c) Sandbox score from systemd's own analyzer.
systemd-analyze security corsproxy.service recognize.service
# Expect: "exposure level" ≤ 1.5 on both. corsproxy should be the
# tightest because it has ReadWritePaths= empty (no writable FS).

# (d) Unattended-upgrades runs.
sudo unattended-upgrades --dry-run --debug 2>&1 | tail -20

# (e) music-svc has no shell.
getent passwd music-svc   # expect: ...:/usr/sbin/nologin

# (f) From inside the corsproxy sandbox, the filesystem really is RO.
sudo -u www-data touch /tmp/should-not-exist /var/test
# Expect: both "Permission denied" or "Read-only file system".
```

## Build artefact requirements

The webapp build (`webapp/build.mjs`) expects `APP_TOKEN` to be set in the
environment when run. Production builds **must** set it. Build-side flow:

```bash
export APP_TOKEN=$(openssl rand -hex 32)
echo "$APP_TOKEN" > .app-token        # local-only, gitignored
cd tasks/music_player_app/webapp && APP_TOKEN="$APP_TOKEN" npm run build
```

The same `APP_TOKEN` value must then be written into the server's
`/etc/musicplayer/corsproxy.env` before `systemctl restart corsproxy`. Order
matters — push the bundle first (so users with a fresh page-load see the new
token), then update the env file and restart.

## Per-release checklist (every deploy must do these)

Each public deploy MUST:

1. **Bump the cache-bust version in `webapp/index.html`.** Search for every
   `?v=N` (where `N` is an integer) and increment them all to the same new
   value. There are at least two — `style.css?v=N` near the top and
   `app.bundle.js?v=N` near the bottom. Both are SW-cached by URL; a forgotten
   one means returning users keep the stale file. Sanity-check with:

   ```bash
   grep -n '?v=' tasks/music_player_app/webapp/index.html
   ```

   All matches should share the new number.

2. **Rotate `APP_TOKEN`** (see the section above). Generate a fresh
   64-hex-char value, build with `APP_TOKEN=… npm run build`, push, then push
   the matching value to `/etc/musicplayer/corsproxy.env` on the server and
   restart `corsproxy`.

3. **Commit + push** the version bump + rebuilt bundle in one commit, then
   `ssh armanserver2 'cd ~/telegram-management-bots && git pull'`.

4. **Verify** with the four curl tests in `.claude/skills/deploy.md` (the
   operational runbook). Expected status codes: 403 (no auth), 403 (wrong
   Origin), 200 (correct Origin + token), `{"ok": true}` from
   `/api/recognize/health`.

If you skip step 1, browsers will keep the old `app.bundle.js` from cache
and call the proxy with the **old** `APP_TOKEN`, which the server has just
rotated away — every page in every open tab will show 403s until the user
hard-refreshes.

## What gets checked at request time

Every request to `https://telemusic.duckdns.org/proxy?url=…` passes through
all of these gates before the proxy will fetch anything upstream:

1. **nginx** — request rejected with 403 unless `Origin` or `Referer` matches `https://telemusic.duckdns.org`.
2. **proxy.js** — same Origin/Referer check repeated server-side.
3. **proxy.js** — `X-App-Token` must constant-time-match the env-var value.
4. **proxy.js** — target URL hostname is in the small allowlist (lyrics/artwork APIs).
5. **proxy.js** — target URL scheme is http/https, port is 80/443, and DNS resolution doesn't land on a private/loopback IP.
6. **proxy.js** — per-IP rate limit (60 burst, 60/min sustained).
7. **proxy.js** — outbound request streams back with a 5 MB cap.

Anyone trying to use this proxy from outside the legitimate webapp needs to
clear all seven. The first three together effectively eliminate "open
relay" abuse; the rest stop classic exploitation patterns.
