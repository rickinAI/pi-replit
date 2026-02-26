# Obsidian Tunnel — Background Service Setup (macOS)

This sets up `cloudflared` as a background service on your Mac so you don't need to keep a terminal window open.

## Prerequisites

- **Obsidian** installed with the **Local REST API** community plugin enabled
- **cloudflared** installed (`brew install cloudflared`)
- Your Replit app URL (e.g., `https://your-app.replit.app`)

## Installation

### Step 1: Copy the tunnel script

```bash
mkdir -p ~/.local/bin
cp start-tunnel.sh ~/.local/bin/start-obsidian-tunnel.sh
chmod +x ~/.local/bin/start-obsidian-tunnel.sh
```

### Step 2: Configure the script

Edit `~/.local/bin/start-obsidian-tunnel.sh` and set these values at the top:

```bash
REPLIT_APP_URL="https://your-app-name.replit.app"
OBSIDIAN_API_KEY="your-obsidian-api-key-here"
```

The `REPLIT_APP_URL` is the public URL of your deployed Replit app. The `OBSIDIAN_API_KEY` is the same key from the Obsidian Local REST API plugin settings.

### Step 3: Install the LaunchAgent

```bash
cp com.cloudflared.obsidian.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.cloudflared.obsidian.plist
```

That's it! The tunnel will now start automatically when you log in.

## Managing the service

**Check status:**
```bash
launchctl list | grep cloudflared
```

**View logs:**
```bash
cat /tmp/cloudflared-obsidian.out.log
cat ~/.obsidian-tunnel.log
```

**See current tunnel URL:**
```bash
cat ~/.obsidian-tunnel-url
```

**Restart the service:**
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

## How it works

1. The LaunchAgent starts `cloudflared` when you log in to your Mac
2. The script captures the tunnel URL from cloudflared's output
3. It saves the URL to `~/.obsidian-tunnel-url`
4. If configured, it automatically notifies your Replit server of the new URL

## Important notes

- **Obsidian must be running** for the tunnel to work. The tunnel connects to the Local REST API plugin which runs inside Obsidian.
- **Obsidian auto-launch**: Go to System Settings → General → Login Items → add Obsidian to "Open at Login"
- The tunnel URL changes each time cloudflared restarts. The script handles this automatically by notifying the Replit server.
- If your Mac sleeps, the tunnel pauses. It resumes when your Mac wakes up.
