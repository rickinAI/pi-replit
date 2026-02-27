# Obsidian Tunnel — Named Tunnel Setup (macOS)

This sets up a **permanent Named Cloudflare Tunnel** so your Obsidian vault is always reachable at a fixed URL. No more rotating URLs or connection drops.

## Prerequisites

- **Obsidian** installed with the **Local REST API** community plugin enabled (port 27124)
- **cloudflared** installed (`brew install cloudflared`)
- A **free Cloudflare account** — sign up at https://dash.cloudflare.com

## One-Time Setup

### Step 1: Log in to Cloudflare

```bash
cloudflared tunnel login
```

This opens a browser window. Pick any domain (or it creates one for you). A certificate is saved to `~/.cloudflared/cert.pem`.

### Step 2: Create the tunnel

```bash
cloudflared tunnel create obsidian-vault
```

This outputs a **Tunnel ID** (a UUID like `a1b2c3d4-...`) and creates a credentials file at:
```
~/.cloudflared/a1b2c3d4-....json
```

Save that Tunnel ID — you'll need it next.

### Step 3: Route DNS

```bash
cloudflared tunnel route dns obsidian-vault obsidian-vault
```

This creates a DNS record pointing `obsidian-vault.YOUR_DOMAIN.com` to your tunnel. If you used Cloudflare's default domain, it'll be something like `obsidian-vault.cfargotunnel.com`.

Note the full hostname — this is your **permanent URL**.

### Step 4: Create the config file

```bash
mkdir -p ~/.cloudflared
```

Copy the template from this repo and edit it:

```bash
cp config.yml ~/.cloudflared/config.yml
```

Edit `~/.cloudflared/config.yml` and fill in:
- `tunnel:` — your Tunnel ID from Step 2
- `credentials-file:` — path to the JSON credentials file from Step 2
- `hostname:` — the DNS hostname from Step 3

Example:
```yaml
tunnel: a1b2c3d4-5678-9abc-def0-123456789abc
credentials-file: /Users/rickin/.cloudflared/a1b2c3d4-5678-9abc-def0-123456789abc.json

ingress:
  - hostname: obsidian-vault.yourdomain.com
    service: https://localhost:27124
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

### Step 5: Test the tunnel

```bash
cloudflared tunnel run obsidian-vault
```

Open your hostname in a browser — you should see the Obsidian REST API response. Press Ctrl+C to stop.

### Step 6: Set the URL in Replit

In your Replit project, update the `OBSIDIAN_API_URL` secret to your permanent tunnel URL:

```
https://obsidian-vault.yourdomain.com
```

This URL never changes. Production and dev both use it.

### Step 7: Install as a background service

```bash
mkdir -p ~/.local/bin
cp start-tunnel.sh ~/.local/bin/start-obsidian-tunnel.sh
chmod +x ~/.local/bin/start-obsidian-tunnel.sh

cp com.cloudflared.obsidian.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cloudflared.obsidian.plist
```

The tunnel now starts automatically when you log in.

## Managing the Service

**Check status:**
```bash
launchctl list | grep cloudflared
```

**View logs:**
```bash
cat /tmp/cloudflared-obsidian.out.log
cat ~/.obsidian-tunnel.log
```

**Restart:**
```bash
launchctl stop com.cloudflared.obsidian
launchctl start com.cloudflared.obsidian
```

**Uninstall:**
```bash
launchctl unload ~/Library/LaunchAgents/com.cloudflared.obsidian.plist
rm ~/Library/LaunchAgents/com.cloudflared.obsidian.plist
rm ~/.local/bin/start-obsidian-tunnel.sh
```

## Migrating from Quick Tunnels

If you previously used Quick Tunnels (random `trycloudflare.com` URLs):

1. Stop the old service: `launchctl unload ~/Library/LaunchAgents/com.cloudflared.obsidian.plist`
2. Follow the setup steps above
3. Replace the old script and plist with the new versions
4. Update `OBSIDIAN_API_URL` in Replit secrets to the permanent hostname
5. The old `REPLIT_APP_URLS` and URL-push mechanism are no longer needed

## Troubleshooting

**Knowledge base shows "offline":**
1. Is Obsidian running on your Mac? The Local REST API plugin must be active.
2. Is the tunnel service running? Check: `launchctl list | grep cloudflared`
3. Can you reach the URL? Try: `curl -k https://obsidian-vault.yourdomain.com`
4. Is your Mac awake? Tunnels pause during sleep and resume on wake.

**"tunnel not found" error:**
- Run `cloudflared tunnel list` to verify the tunnel exists
- Make sure `~/.cloudflared/config.yml` has the correct tunnel ID and credentials path

**Certificate errors:**
- The `noTLSVerify: true` in the config handles the self-signed cert from Obsidian's REST API

## How It Works

Unlike Quick Tunnels (which get random URLs that rotate), a Named Tunnel has a permanent hostname tied to your Cloudflare account. The tunnel ID and credentials are stored locally on your Mac. Cloudflare routes traffic from the fixed hostname to your local Obsidian instance through an encrypted connection.

The URL never changes, so `OBSIDIAN_API_URL` in Replit only needs to be set once.
