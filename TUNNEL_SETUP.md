# Connecting Obsidian to your Pi Agent

This guide walks you through exposing your local Obsidian vault to the internet
so the deployed pi agent can read, search, and create notes.

## Prerequisites

- Obsidian running on your computer
- The "Local REST API" community plugin installed and enabled in Obsidian

## Step 1: Get your Obsidian API key

1. Open Obsidian
2. Go to Settings > Community Plugins > Local REST API
3. Copy the **API Key** shown in the plugin settings
4. In Replit, add it as a secret called `OBSIDIAN_API_KEY`

## Step 2: Install Cloudflare Tunnel (cloudflared)

### macOS
```bash
brew install cloudflared
```

### Windows
Download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

### Linux
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/
```

## Step 3: Start the tunnel

The Obsidian Local REST API runs on port 27124 by default. Run this command
on the same machine where Obsidian is running:

```bash
cloudflared tunnel --url http://localhost:27124
```

You will see output like:
```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
|  https://something-random-words.trycloudflare.com                                          |
+--------------------------------------------------------------------------------------------+
```

Copy that URL (e.g., `https://something-random-words.trycloudflare.com`).

## Step 4: Add the URL to Replit

1. In Replit, go to the Secrets tab
2. Add a new secret: `OBSIDIAN_API_URL` with the tunnel URL as the value
3. Restart the application

## Step 5: Test it

Chat with the agent and ask it to search or read your notes. For example:
- "Search my notes for project ideas"
- "Read my daily note"
- "Create a new note called Ideas/app-concept.md with some content"

## Important notes

- The tunnel URL changes every time you restart `cloudflared` (unless you set up a
  named tunnel with a Cloudflare account — the free quick tunnel is fine for personal use)
- Obsidian must be open on your computer for the API to work
- If you restart `cloudflared`, update the `OBSIDIAN_API_URL` secret in Replit with the new URL

## Optional: Persistent tunnel (free Cloudflare account)

If you want a stable URL that doesn't change:

1. Create a free Cloudflare account at https://dash.cloudflare.com
2. Run `cloudflared tunnel login`
3. Create a named tunnel: `cloudflared tunnel create obsidian`
4. Run it: `cloudflared tunnel run --url http://localhost:27124 obsidian`

This gives you a permanent subdomain you can use.
