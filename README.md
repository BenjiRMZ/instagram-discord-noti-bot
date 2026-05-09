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

1. Launches a Chromium browser with a persistent session directory (`ig_state/`)
2. Checks if the session is still logged in — logs in automatically if not
3. Calls Instagram's internal feed API to get the latest posts and reels
4. Compares each against the last seen URL stored locally
5. Sends a Discord embed if something new is found, then saves the URL

The bot is designed to be run on a schedule (e.g. cron every 10–15 minutes). It does not run continuously.

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

- Instagram occasionally changes its internal API structure or CSS class names, which can break image extraction. The debug HTML files help diagnose this.
- If Instagram forces a security challenge mid-run, the bot will throw and exit. Re-run with `MANUAL_LOGIN_MODE=true HEADLESS=false` to resolve it.
- The bot monitors one target account at a time. To monitor multiple accounts, run separate instances with different `.env` files.
