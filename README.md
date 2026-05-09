# 📢 Instagram → Discord Notification Bot

A bot that monitors Instagram activity and sends real-time notifications to a Discord channel.

## ✨ Features

- Monitors Instagram accounts for new activity
- Sends notifications to Discord via webhook/bot
- Real-time event handling
- Simple and extensible architecture

---

## 🧠 Tech Stack

- Node.js
- Discord API
- Instagram integration

---

## How it works

```
Instagram Profile
       │
       ▼
  Feed API call (internal, authenticated)
       │
       ├── New post? ──► Discord embed notification
       │                        │
       └── New reel? ──►        └── saves URL to last_post.json / last_reel.json
```

Each run does one check and exits — it's meant to be called by a scheduler (like cron) every 10–15 minutes, not left running continuously.

The basic flow:
1. Launch a browser with a saved session from the last run
2. If the session expired, log in again (or wait for manual login if 2FA is needed)
3. Hit Instagram's internal feed API to get the latest posts and reels
4. Compare each against the last seen URL stored in a local JSON file
5. If something changed, send a Discord embed and update the saved URL
---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
IG_USERNAME=your_instagram_username
IG_PASSWORD=your_instagram_password
IG_TARGET_USERNAME=the_account_to_monitor

DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

HEADLESS=true
MANUAL_LOGIN_MODE=false
STATE_DIR=./ig_state
``

### 3. First-time login

Instagram often triggers a security challenge on first login from a new machine. To handle this, do one manual login run:

```bash
MANUAL_LOGIN_MODE=true HEADLESS=false node app.js
```

A browser window will open. Log in manually and complete any 2FA or challenge. Once the home feed loads, the session is saved to `ig_state/` and the bot will reuse it automatically on future runs.

After that, set `MANUAL_LOGIN_MODE=false` in your `.env`.

### 4. Run the bot

```bash
node app.js
```

---

## Running on a schedule

The bot checks once per run and exits. Use a scheduler to run it repeatedly.

**Linux/macOS (cron) — check every 10 minutes:**
```bash
crontab -e
```
```
*/10 * * * * cd /path/to/bot && node app.js >> bot.log 2>&1
```

**Windows (Task Scheduler):**
Create a task that runs `node app.js` from the project directory on a 10-minute repeat trigger.

---

## Known limitations

- Instagram changes its internal structure occasionally, which can break image extraction. The debug HTML files are the first place to look when that happens.
- If Instagram triggers a security challenge mid-run, the bot exits and you'll need to re-run with `MANUAL_LOGIN_MODE=true HEADLESS=false` to clear it manually.
- One target account per instance. To monitor multiple accounts, run separate copies with different `.env` files.
