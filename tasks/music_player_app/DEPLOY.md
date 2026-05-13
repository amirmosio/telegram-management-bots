# Music Player — production deployment checklist

This file lives in the repo (visible on GitHub). It documents what the server
needs in place for the webapp + CORS proxy + recognize service to run. The
operational runbook with copy-pastable commands is in `.claude/skills/deploy.md`
(local-only).

## Public domain

**`telemusic.duckdns.org`** — the only domain this project serves. Used in:

- nginx `server_name`
- TLS cert subject (Let's Encrypt via certbot)
- `ALLOWED_ORIGIN` env var in `/etc/musicplayer/corsproxy.env`
- Origin/Referer allowlist in nginx + proxy.js
- DuckDNS A record (update via DuckDNS panel or token-based curl, pointing
  to the VPS's current public IP whenever it rotates)

If you ever change this domain (move off DuckDNS, take a custom domain),
search-and-replace it across this file, `proxy.js`, `webapp/build.mjs`,
and `webapp/src/cors-proxy.js`, and re-issue the TLS cert.

## Source code on the server — GitHub deploy key

The server has a **read-only GitHub deploy key** for this repo so it
can `git pull` even after the repo is made private. The key is on disk
at `~/.ssh/gh-telegram-music` (ubuntu user), and the matching public
key is registered on GitHub under
*Settings → Deploy keys → "armanserver2-telegram-music-deploy-…"*.

To make `git pull` automatically use that key (rather than HTTPS + no
auth), the server's `~/.ssh/config` defines a per-repo alias:

```ssh-config
Host github-telegram-music
    HostName github.com
    User git
    IdentityFile ~/.ssh/gh-telegram-music
    IdentitiesOnly yes
```

The checkout's `origin` URL uses that alias instead of `github.com`:

```bash
git remote -v
# origin  git@github-telegram-music:amirmosio/telegram-management-bots.git (fetch)
# origin  git@github-telegram-music:amirmosio/telegram-management-bots.git (push)
```

Push won't work from the server (the key is read-only on the GitHub
side) — that's intentional. The server is a read-only consumer of the
repo; pushes happen from your laptop.

**First-time setup on a fresh box** (or if the box was rebuilt):

```bash
# 1. Generate the keypair on the server (ed25519, no passphrase).
ssh-keygen -t ed25519 -N "" \
    -C "armanserver2-telegram-music-deploy-$(date +%Y%m%d)" \
    -f ~/.ssh/gh-telegram-music

# 2. Paste ~/.ssh/gh-telegram-music.pub into the repo's Deploy keys
#    page on GitHub (Allow write access: UNCHECKED).

# 3. Add the SSH alias above to ~/.ssh/config.

# 4. Pre-seed the github.com host key so the first pull doesn't prompt:
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts

# 5. Clone (or re-point an existing checkout):
git clone git@github-telegram-music:amirmosio/telegram-management-bots.git \
    /home/ubuntu/telegram-management-bots
# OR for an existing checkout:
cd /home/ubuntu/telegram-management-bots
git remote set-url origin git@github-telegram-music:amirmosio/telegram-management-bots.git

# 6. Verify:
ssh -T git@github-telegram-music
# Expect: "Hi amirmosio/telegram-management-bots! You've successfully authenticated, ..."
```

**Deploys are git-pull only.** Every release lands via:

```bash
ssh armanserver2 'cd ~/telegram-management-bots && git pull --ff-only'
```

No `rsync`, no `scp`, no file-by-file copies — because that would
silently carry over untracked files (`.DS_Store`, build caches, stray
backup zips) and drift from what's actually committed. Anything that
needs to be on the server but NOT in the repo (e.g. the `APP_TOKEN`
secret, the corsproxy env file, the Python venv) is provisioned out-of-band
via the §3, §5 etc. sections below — never via the deploy path.

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

The webapp build (`webapp/build.mjs`) bakes `APP_TOKEN` into
`app.bundle.js` at compile time via esbuild's `define`. Because that
makes the bundle a carrier of the secret, **the bundle MUST NOT be
committed to git** — it's listed in the root `.gitignore` as
`tasks/music_player_app/webapp/app.bundle.js`. The bundle is produced
**on the server** at deploy time, reading `APP_TOKEN` from the
authoritative location (`/etc/musicplayer/corsproxy.env`).

### One-time: install the webapp's build dependencies on the server

```bash
sudo apt-get install -y nodejs npm     # already done per §0/topology
cd /home/ubuntu/telegram-management-bots/tasks/music_player_app/webapp
npm install                            # gets esbuild + plugins (~50 MB)
```

`npm install` only needs to be re-run when `package.json` / `package-lock.json`
change (very rare — esbuild updates only). The build script (`node build.mjs`)
runs in ~200 ms with peak memory <500 MB, well within the 2 GB box.

## Per-release checklist (every deploy must do these)

Each public deploy MUST:

1. **Bump the cache-bust version in `webapp/index.html`.** Search for every
   `?v=N` and increment them all to the same new value. There are at least
   four — `manifest.json?v=N`, `apple-touch-icon?v=N`, `style.css?v=N`,
   `app.bundle.js?v=N`. All are SW-cached by URL; a forgotten one means
   returning users keep the stale file. Sanity-check with:

   ```bash
   grep -n '?v=' tasks/music_player_app/webapp/index.html
   ```

   All matches should share the new number.

2. **Commit + push** the change set (`index.html` cache-bust, any code
   edits). The bundle is **not** in the commit — it's gitignored.

3. **Pull + rebuild on the server** in one command:

   ```bash
   ssh armanserver2 '
     cd ~/telegram-management-bots && git pull --ff-only && \
     cd tasks/music_player_app/webapp && \
     APP_TOKEN=$(sudo awk -F= "/^APP_TOKEN=/{print \$2}" /etc/musicplayer/corsproxy.env) \
       npm run build
   '
   ```

   nginx serves the new bundle on the next request — no service restart.
   Rebuilding doesn't change the `APP_TOKEN` (it's read FROM the env file,
   not generated); the env file remains the single source of truth.

4. **Verify** with the four curl tests in `.claude/skills/deploy.md`.
   Expected: 403 (no auth), 403 (wrong Origin), 200 (correct Origin + token),
   `{"ok": true}` from `/api/recognize/health`.

### Rotating `APP_TOKEN`

Rotation is a server-side operation now — the laptop is uninvolved.

```bash
ssh armanserver2 '
  NEW=$(openssl rand -hex 32)
  sudo sed -i "s|^APP_TOKEN=.*|APP_TOKEN=$NEW|" /etc/musicplayer/corsproxy.env
  cd ~/telegram-management-bots/tasks/music_player_app/webapp
  APP_TOKEN="$NEW" npm run build
  sudo systemctl restart corsproxy
'
```

Bundle and env file land in sync — the server reads from the env file
to set the build's `__APP_TOKEN__`, then the corsproxy reloads the same
env file on restart. There's no laptop ↔ server token-sync to keep
straight, and the token never appears in git.

If you skip step 1 of the per-release checklist (the `?v=` bump),
browsers will keep the old `app.bundle.js` from cache and call the
proxy with the old `APP_TOKEN`, which the env file has just rotated
away — every page in every open tab will show 403s until the user
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
