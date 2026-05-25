# 🎬 Virtual Cinema

A private, self-hosted virtual cinema for two — screen sharing, video streaming, voice/video chat, and real-time text chat. Built with Node.js, Socket.io, and WebRTC.

---

## Architecture Overview

```
Browser A ──── Socket.io ────► Node.js Server ◄──── Socket.io ──── Browser B
              (Signaling only)                      (Signaling only)
                    │
                    └─ STUN (Google/Cloudflare) for NAT traversal
                    
Browser A ◄══════════════ WebRTC P2P ══════════════► Browser B
                    (Video/Audio/Screen — direct)
```

The server **only** handles signaling (WebRTC handshake + chat messages). All media streams are peer-to-peer, so Render's free tier bandwidth is never consumed by video data.

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Start server
npm run dev   # uses nodemon for hot-reload

# 3. Open in browser
open http://localhost:3000

# Default password: cinema123
# Change it by setting the ROOM_PASSWORD environment variable
```

---

## Deploy to Render (Free Tier) — Step by Step

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "feat: initial virtual cinema"
git remote add origin https://github.com/YOUR_USERNAME/virtual-cinema.git
git push -u origin main
```

### Step 2 — Create a Render Account
Go to https://render.com and sign up (free).

### Step 3 — Create a New Web Service

1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub account and select the `virtual-cinema` repository
3. Configure:
   - **Name:** `virtual-cinema` (or anything you like)
   - **Region:** Choose closest to you
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`

### Step 4 — Set Environment Variables

In the Render dashboard for your service, go to **Environment** and add:

| Key             | Value              |
|-----------------|--------------------|
| `ROOM_PASSWORD` | `your-secret-pass` |
| `NODE_ENV`      | `production`       |

**Important:** Change `ROOM_PASSWORD` from the default `cinema123` to something only you and your partner know.

### Step 5 — Deploy

Click **"Create Web Service"**. Render will:
1. Pull your code from GitHub
2. Run `npm install`
3. Start the server with `npm start`

Deployment takes ~2 minutes. You'll get a URL like `https://virtual-cinema-xxxx.onrender.com`.

### Step 6 — Share the URL

Send the URL and password to your partner. That's it — your private cinema is live!

---

## Free Tier Notes

- **Sleep after inactivity:** Render free tier spins down after 15 minutes of no HTTP requests. First load after sleep takes ~30 seconds. Both users should open the site around the same time.
- **No persistent storage:** Chat history is in-memory only. It resets on each deploy/restart (last 50 messages preserved during a session).
- **Bandwidth:** Since all video is P2P (WebRTC), Render's servers don't handle video data. Bandwidth usage is minimal (only signaling + chat text).

---

## Features

| Feature | Implementation |
|---------|----------------|
| Password auth | Single shared room password, server-enforced |
| Text chat | Socket.io real-time messages, last 50 history |
| Voice & video | WebRTC P2P, camera/mic toggle |
| Screen share | `getDisplayMedia` → WebRTC track replacement |
| Video file stream | `captureStream()` on `<video>` element |
| Quality settings | MediaStream constraints (1080p/720p/480p/360p) |
| Connection resilience | ICE restart on failure, Socket.io auto-reconnect |
| Max 2 users | Server enforced |

---

## Browser Support

| Browser | Support |
|---------|---------|
| Chrome / Edge | ✅ Full |
| Firefox | ✅ Full |
| Safari 15.4+ | ✅ (screen share limited on iOS) |
| Mobile Chrome | ✅ Camera/chat (no screen share) |

---

## Troubleshooting

**"Room is full"** — Refresh both browsers to reset. If one person is stuck, they can refresh.

**No video from partner** — Both must allow camera/mic permissions. Check the browser's address bar for the camera icon.

**Screen share not working** — Must be on HTTPS (Render handles this). Won't work on `http://localhost` — use `https://` for screen share.

**Connection drops** — WebRTC uses ICE restart automatically. If persistent, try: both users refresh at the same time.

**Partner's video in wrong place** — Known edge case when both join simultaneously. Refresh resolves it.
