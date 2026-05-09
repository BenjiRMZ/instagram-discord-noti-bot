/**
 * Instagram → Discord Notification Bot
 *
 * Checks a target Instagram account for new posts and reels,
 * and sends a Discord webhook notification when something new shows up.
 *
 * I built this to avoid checking Instagram manually — it runs on a cron schedule,
 * does one check, and exits. No long-running process needed.
 *
 * How a run works:
 *   1. Launch a browser using the saved session from last time
 *   2. If the session is gone, log in again (or prompt for manual login if 2FA blocks it)
 *   3. Call Instagram's internal feed API to get the latest posts and reels
 *   4. Compare each against the URL saved from last run
 *   5. If something new is there, send a Discord embed and save the new URL
 *
 * Environment variables — all in .env (see .env.example):
 *   IG_USERNAME / IG_PASSWORD      Instagram credentials for auto-login
 *   IG_TARGET_USERNAME             The account to monitor
 *   DISCORD_WEBHOOK_URL            Where to send notifications
 *   HEADLESS                       "true" to hide the browser window
 *   MANUAL_LOGIN_MODE              "true" to skip auto-login and do it by hand
 *   STATE_DIR                      Where to persist the browser session
 */

require("dotenv").config();
const puppeteer = require("puppeteer");
const axios     = require("axios");
const fs        = require("fs");
const path      = require("path");

// ============================================================================
// Config
// ============================================================================

const INSTAGRAM_USERNAME  = process.env.IG_USERNAME;
const INSTAGRAM_PASSWORD  = process.env.IG_PASSWORD;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TARGET_IG           = process.env.IG_TARGET_USERNAME;

const HEADLESS          = process.env.HEADLESS === "true";
const MANUAL_LOGIN_MODE = process.env.MANUAL_LOGIN_MODE === "true";

// Puppeteer saves cookies and localStorage here so we stay logged in between runs.
// Without this, every run would be a fresh browser and Instagram would flag it fast.
const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "ig_state");

// These files store the URL from the last seen post/reel.
// On the next run we compare against these to know if anything is new.
const LAST_POST_FILE = "last_post.json";
const LAST_REEL_FILE = "last_reel.json";

// ============================================================================
// Utilities
// ============================================================================

function getFormattedDate() {
    const now = new Date();
    return now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function saveJson(filePath, obj) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// Returns null instead of throwing if the file doesn't exist yet.
// This handles the first run cleanly without needing any special setup.
function loadJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveLastPost(postUrl) { saveJson(LAST_POST_FILE, { lastPost: postUrl }); }
function loadLastPost()        { return loadJson(LAST_POST_FILE)?.lastPost ?? null; }

function saveLastReel(reelUrl) { saveJson(LAST_REEL_FILE, { lastReel: reelUrl }); }
function loadLastReel()        { return loadJson(LAST_REEL_FILE)?.lastReel ?? null; }

// Fail fast with a clear message before anything else runs.
// Better than crashing halfway through with a confusing undefined error.
function ensureEnv() {
    if (!DISCORD_WEBHOOK_URL) {
        throw new Error("Missing DISCORD_WEBHOOK_URL env var.");
    }
    if (!MANUAL_LOGIN_MODE && (!INSTAGRAM_USERNAME || !INSTAGRAM_PASSWORD)) {
        throw new Error("Missing IG_USERNAME or IG_PASSWORD env vars.");
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Saves the page HTML when something goes wrong so I can open it in a browser
// and see exactly what Instagram was showing at the time of failure.
async function saveDebugHtml(page, name = "debug") {
    try {
        const html = await page.content();
        fs.writeFileSync(path.join(__dirname, `${name}.html`), html);
        console.log(`📝 Saved debug HTML: ${name}.html`);
    } catch (err) {
        console.log("⚠️ Failed to save debug HTML:", err.message);
    }
}

// ============================================================================
// Browser setup
// ============================================================================

async function launchBrowser() {
    return puppeteer.launch({
        headless: HEADLESS,
        userDataDir: STATE_DIR,
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        defaultViewport: { width: 1366, height: 900 }
    });
}

// ============================================================================
// Page state detection
// ============================================================================

// Instagram sometimes returns this generic error page instead of content,
// usually due to rate limiting or a momentary server issue.
async function isInstagramLoadError(page) {
    const info = await page.evaluate(() => ({
        title: document.title || "",
        body:  document.body?.innerText?.slice(0, 1500) || ""
    }));

    const title = info.title.toLowerCase();
    const body  = info.body.toLowerCase();

    return (
        title.includes("seite konnte nicht geladen werden") ||
        title.includes("page couldn't load") ||
        body.includes("seite konnte nicht geladen werden") ||
        body.includes("page couldn't load") ||
        body.includes("something went wrong")
    );
}

// Instagram shows a checkpoint when it thinks the login looks suspicious.
// This requires manual action (email/phone confirm) — the bot can't get past it alone.
async function detectCheckpoint(page) {
    const url = page.url();

    if (url.includes("/challenge/") || url.includes("/accounts/suspended/") || url.includes("/checkpoint/")) {
        return true;
    }

    const body = (await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || "")).toLowerCase();

    return (
        body.includes("suspicious") ||
        body.includes("challenge") ||
        body.includes("confirm it's you") ||
        body.includes("verify") ||
        body.includes("checkpoint") ||
        body.includes("help us confirm you own this account")
    );
}

// Checks three things: no login form visible, not on the login URL, and no
// "log in / sign up" text — all three need to pass for us to trust the session.
async function pageLooksLoggedIn(page) {
    const url           = page.url();
    const body          = (await page.evaluate(() => document.body?.innerText?.slice(0, 2500) || "")).toLowerCase();
    const hasLoginInput = await page.$('input[name="username"]');

    if (hasLoginInput)                                     return false;
    if (url.includes("/accounts/login"))                   return false;
    if (body.includes("log in") && body.includes("sign up")) return false;

    return true;
}

// ============================================================================
// Navigation
// ============================================================================

// Retries navigation a few times in case of flaky load errors.
// Adds a short delay after each load to let dynamic content settle
// before we try to read anything from the DOM.
async function gotoWithRetries(page, url, tries = 3) {
    let lastErr;

    for (let i = 0; i < tries; i++) {
        try {
            console.log(`🌐 Navigating to ${url} (attempt ${i + 1}/${tries})`);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
            await sleep(3500);

            if (await isInstagramLoadError(page)) {
                throw new Error("Instagram returned a load-error page");
            }

            return;
        } catch (err) {
            lastErr = err;
            console.log(`⚠️ Navigation failed (${i + 1}/${tries}): ${err.message}`);
            await sleep(3000);
        }
    }

    throw lastErr;
}

// ============================================================================
// Login
// ============================================================================

async function loginInstagram(page) {
    console.log("🔐 Logging into Instagram...");

    await gotoWithRetries(page, "https://www.instagram.com/accounts/login/");
    await page.waitForSelector('input[name="username"]', { timeout: 20000 });

    // Clear the field before typing — avoids issues if it has a pre-filled value
    await page.click('input[name="username"]', { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type('input[name="username"]', INSTAGRAM_USERNAME, { delay: 30 });

    await page.click('input[name="password"]', { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type('input[name="password"]', INSTAGRAM_PASSWORD, { delay: 30 });

    await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null)
    ]);

    await sleep(5000);

    if (await detectCheckpoint(page)) {
        throw new Error("Login led to a checkpoint — manual verification needed.");
    }

    if (!(await pageLooksLoggedIn(page))) {
        await saveDebugHtml(page, "login_failed");
        throw new Error("Login failed or session not accepted.");
    }

    console.log("✅ Logged in.");
}

// Checks if we're already logged in from the saved session.
// Only calls loginInstagram() if we're not — avoids unnecessary logins.
async function ensureLoggedIn(page) {
    await gotoWithRetries(page, "https://www.instagram.com/");

    if (await detectCheckpoint(page)) {
        throw new Error("Checkpoint detected on load — manual verification needed.");
    }

    if (await pageLooksLoggedIn(page)) {
        console.log("✅ Session is still valid.");
        return;
    }

    if (MANUAL_LOGIN_MODE) {
        throw new Error("MANUAL_LOGIN_MODE is on but no active session was found.");
    }

    await loginInstagram(page);
}

// Used when Instagram blocks automated login with a 2FA or challenge.
// Opens a real browser window and waits up to 4 minutes for the user to log in.
// Once the home feed is detected, the session is saved and future runs go automated.
async function runManualLoginMode(page) {
    console.log("🛠️ Manual login mode — opening browser...");
    await gotoWithRetries(page, "https://www.instagram.com/accounts/login/");

    console.log("👉 Log in manually. Complete any 2FA or challenge Instagram shows.");
    console.log("👉 Wait until the home feed loads, then this will continue automatically.");

    for (let i = 0; i < 120; i++) {
        await sleep(2000);

        if (await detectCheckpoint(page)) {
            console.log("⚠️ Challenge still active — keep going.");
            continue;
        }

        if (await pageLooksLoggedIn(page)) {
            console.log("✅ Login detected. Session saved to ig_state/.");
            return true;
        }
    }

    throw new Error("Timed out waiting for manual login.");
}

// ============================================================================
// Instagram internal API
// ============================================================================

// The request runs inside the browser page rather than Node.js because
// Instagram's API requires session cookies to be sent with it.
// A plain Node.js fetch has no access to the browser's cookie jar —
// running it inside the page means the cookies are already there.
async function fetchInstagramJson(page, url) {
    return page.evaluate(async (targetUrl) => {
        try {
            const response = await fetch(targetUrl, {
                method: "GET",
                credentials: "include",
                headers: { "accept": "*/*", "x-requested-with": "XMLHttpRequest" }
            });

            const text = await response.text();
            let data = null;
            try { data = JSON.parse(text); } catch (_) {}

            return { ok: response.ok, status: response.status, text, data };
        } catch (err) {
            return { ok: false, status: 0, text: String(err), data: null };
        }
    }, url);
}

// ============================================================================
// Media extraction helpers
// ============================================================================

// Instagram returns images in multiple resolutions — we take the first candidate
// which is typically the highest quality. Falls back through carousel and thumbnail.
function extractImageFromItem(item) {
    return (
        item?.image_versions2?.candidates?.[0]?.url ||
        item?.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
        item?.thumbnail_url ||
        null
    );
}

function extractCaptionFromItem(item) {
    return item?.caption?.text || "No caption available";
}

// Pinned posts sit at the top of a profile regardless of when they were posted,
// so we skip them when looking for the "latest" post.
function isPinnedItem(item) {
    return Boolean(item?.is_pinned || item?.pinned_for_users?.length);
}

// Builds the public Instagram URL from the item's short code.
// Posts: /p/<code>/ — Reels: /reel/<code>/
function buildMediaUrl(item, isReel = false) {
    if (!item?.code) return null;
    return isReel
        ? `https://www.instagram.com/reel/${item.code}/`
        : `https://www.instagram.com/p/${item.code}/`;
}

// Fetches up to 12 items from Instagram's internal user feed API.
// This is the same endpoint the Instagram web app uses — it requires
// an active authenticated session, which is why we call it from inside the browser.
async function getFeedItems(page, username) {
    const url    = `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=12`;
    const result = await fetchInstagramJson(page, url);

    if (!result.ok || !result.data) {
        console.log("⚠️ Feed API failed:", result.status);
        console.log("⚠️ Response preview:", (result.text || "").slice(0, 500));
        return null;
    }

    const items = Array.isArray(result.data.items) ? result.data.items : [];
    console.log(`📦 Feed API returned ${items.length} items`);
    return items;
}

// Navigates to a post or reel page and pulls the image and caption from the DOM.
// Used as a fallback when the feed API doesn't return complete image data.
// Reel pages don't render img.x5yr21d, so we prefer og:image there instead.
async function getMediaPageData(page, mediaUrl, isReel = false) {
    await gotoWithRetries(page, mediaUrl);
    await sleep(5000);

    const data = await page.evaluate((reelMode) => {
        const oldPostImage   = document.querySelector('img.x5yr21d')?.src || null;
        const articleImg     = document.querySelector('article img')?.src || null;
        const metaOgImage    = document.querySelector('meta[property="og:image"]')?.content || null;
        const metaTwitterImg = document.querySelector('meta[name="twitter:image"]')?.content || null;

        const captionElement = document.querySelector('h1[dir="auto"]');
        const domCaption     = captionElement ? captionElement.innerText.trim() : null;
        const metaCaption    = document.querySelector('meta[property="og:description"]')?.content || null;

        // og:description usually looks like "username: caption text" — strip the username prefix
        let caption = domCaption || "No caption available";
        if (!domCaption && metaCaption) {
            const parts = metaCaption.split(":");
            caption = parts.length > 1 ? parts.slice(1).join(":").trim() : metaCaption.trim();
        }

        const imageUrl = reelMode
            ? (metaOgImage || metaTwitterImg || articleImg || null)
            : (oldPostImage || articleImg || metaOgImage || metaTwitterImg || null);

        return { imageUrl, caption, debug: { oldPostImage, articleImg, metaOgImage, metaTwitterImg } };
    }, isReel);

    console.log("🖼️ Image extraction debug:", data.debug);
    return data;
}

// ============================================================================
// Post and reel fetching
// ============================================================================

// Finds the latest non-pinned, non-reel post for the given account.
//
// Tries the feed API first since it's fast and structured.
// Falls back to scanning DOM links if the API returns nothing.
// Either way, navigates to the post page at the end to extract
// the best available image (highest srcset resolution).
async function getLatestPost(page, username) {
    console.log(`📸 Checking posts for @${username}`);
    await gotoWithRetries(page, `https://www.instagram.com/${username}/`);

    if (await detectCheckpoint(page)) throw new Error("Checkpoint on profile page.");

    const items    = await getFeedItems(page, username);
    let postUrl    = null;
    let latestPost = null;

    if (items?.length) {
        latestPost = items.find(item =>
            item?.product_type !== "clips" && !isPinnedItem(item) && item?.code
        );

        if (latestPost) {
            postUrl = buildMediaUrl(latestPost, false);
            console.log("📌 Latest post from API:", postUrl);
        }
    }

    // DOM fallback — scan <a> tags for /p/ links
    if (!postUrl) {
        console.log("⚠️ API returned nothing. Falling back to DOM scan.");
        await sleep(4000);

        postUrl = await page.evaluate(() => {
            const links = [...new Set(
                Array.from(document.querySelectorAll("a"))
                    .map(a => a.href)
                    .filter(href => href.includes("/p/"))
            )];
            return links[0] || null;
        });
    }

    if (!postUrl) {
        console.log("❌ No post found.");
        await saveDebugHtml(page, "profile_debug");
        return null;
    }

    await gotoWithRetries(page, postUrl);
    await sleep(5000);

    const postData = await page.evaluate(() => {
        // Parse srcset to get the highest resolution version of the image
        function getLargestFromSrcset(srcset) {
            if (!srcset) return null;
            return srcset
                .split(",")
                .map(part => {
                    const [url, width] = part.trim().split(" ");
                    return { url, width: parseInt(width, 10) || 0 };
                })
                .filter(x => x.url)
                .sort((a, b) => b.width - a.width)[0]?.url ?? null;
        }

        const img =
            document.querySelector("div._aagu._aato div._aagv img.x5yr21d") ||
            document.querySelector("div._aagv img.x5yr21d") ||
            document.querySelector("img.x5yr21d");

        const image    = getLargestFromSrcset(img?.getAttribute("srcset") || "") || img?.src || null;
        const domCap   = document.querySelector('h1[dir="auto"]')?.innerText.trim() || null;
        const metaCap  = document.querySelector('meta[property="og:description"]')?.content || null;

        let caption = domCap || "No caption available";
        if (!domCap && metaCap) {
            const parts = metaCap.split(":");
            caption = parts.length > 1 ? parts.slice(1).join(":").trim() : metaCap.trim();
        }

        return { image, caption };
    });

    return {
        postUrl,
        imageUrl: postData.image || (latestPost ? extractImageFromItem(latestPost) : null),
        caption:  postData.caption
    };
}

// Finds the latest non-pinned reel for the given account.
// Same strategy as getLatestPost — API first, DOM fallback second.
//
// One quirk: the first few /reel/ links in the DOM tend to be UI navigation elements
// rather than actual content, so we skip them and take the 4th unique one.
async function getLatestReel(page, username) {
    console.log(`🎬 Checking reels for @${username}`);
    await gotoWithRetries(page, `https://www.instagram.com/${username}/reels/`);

    if (await detectCheckpoint(page)) throw new Error("Checkpoint on reels page.");

    const items = await getFeedItems(page, username);
    console.log("🎬 Items from feed API:", items?.length || 0);

    if (items?.length) {
        console.log("🎬 First 5 items:");
        items.slice(0, 5).forEach((item, i) =>
            console.log(i, { code: item?.code, product_type: item?.product_type, media_type: item?.media_type })
        );
    }

    if (items?.length) {
        const latestReel = items.find(item =>
            item?.product_type === "clips" && item?.code && !isPinnedItem(item)
        );

        if (latestReel) {
            const reelUrl       = buildMediaUrl(latestReel, true);
            console.log("📌 Latest reel from API:", reelUrl);

            const mediaPageData = await getMediaPageData(page, reelUrl, true);
            return {
                reelUrl,
                thumbUrl: mediaPageData.imageUrl || extractImageFromItem(latestReel),
                caption:  mediaPageData.caption  || extractCaptionFromItem(latestReel)
            };
        }
    }

    console.log("⚠️ API returned nothing. Falling back to DOM scan.");
    await sleep(4000);

    console.log("🎬 Reel links found in DOM:", await page.evaluate(() =>
        Array.from(document.querySelectorAll("a"))
            .map(a => a.href)
            .filter(href => href.includes("/reel/"))
            .slice(0, 10)
    ));

    const reelUrl = await page.evaluate(() => {
        const links = [...new Set(
            Array.from(document.querySelectorAll("a"))
                .map(a => a.href)
                .filter(href => href.includes("/reel/"))
        )];
        // First few links are usually navigation UI, not actual reels
        return links.length > 3 ? links[3] : links[0] || null;
    });

    if (!reelUrl) {
        console.log("❌ No reel found.");
        await saveDebugHtml(page, "reels_debug");
        return null;
    }

    const mediaPageData = await getMediaPageData(page, reelUrl, true);
    return { reelUrl, thumbUrl: mediaPageData.imageUrl, caption: mediaPageData.caption };
}

// ============================================================================
// Discord notification
// ============================================================================

/**
 * Sends a Discord embed for a new post or reel.
 *
 * @param {string}  url      Public Instagram URL of the post or reel
 * @param {string}  mediaUrl Direct image/thumbnail URL for the embed preview
 * @param {string}  caption  Caption text
 * @param {boolean} isReel   Changes the embed title from "Post" to "Reel"
 */
async function sendDiscordNotification(url, mediaUrl, caption, isReel = false) {
    if (!url) return;

    const embed = {
        title:       `New Instagram ${isReel ? "Reel" : "Post"} from ${TARGET_IG}!`,
        description: caption || "",
        url,
        fields:      [{ name: "🔗 Link", value: `[Click Here](${url})` }],
        color:       0x8a2be2,
        footer:      { text: `${TARGET_IG} | instagram.com • ${getFormattedDate()}` }
    };

    if (mediaUrl) embed.image = { url: mediaUrl };

    await axios.post(DISCORD_WEBHOOK_URL, {
        content:          `@everyone ${url}`,
        embeds:           [embed],
        allowed_mentions: { parse: ["everyone"] }
    });

    console.log("✅ Notification sent:", url);
}

// ============================================================================
// Entry point
// ============================================================================

async function main() {
    ensureEnv();
    console.log("🚀 Starting run");
    console.log(`   HEADLESS=${HEADLESS} | MANUAL_LOGIN_MODE=${MANUAL_LOGIN_MODE} | STATE_DIR=${STATE_DIR}`);

    const browser = await launchBrowser();
    const page    = await browser.newPage();

    try {
        if (MANUAL_LOGIN_MODE) {
            await runManualLoginMode(page);
            console.log("✅ Manual login done. Set MANUAL_LOGIN_MODE=false for future runs.");
            return;
        }

        await ensureLoggedIn(page);

        // Check for a new post
        const postData = await getLatestPost(page, TARGET_IG).catch(async err => {
            console.log("⚠️ Post check failed:", err.message);
            await saveDebugHtml(page, "post_failure");
            return null;
        });

        if (postData) {
            if (postData.postUrl !== loadLastPost()) {
                console.log("🆕 New post — sending notification");
                await sendDiscordNotification(postData.postUrl, postData.imageUrl, postData.caption, false);
                saveLastPost(postData.postUrl);
            } else {
                console.log("🟰 No new post.");
            }
        }

        // Check for a new reel
        const reelData = await getLatestReel(page, TARGET_IG).catch(async err => {
            console.log("⚠️ Reel check failed:", err.message);
            await saveDebugHtml(page, "reel_failure");
            return null;
        });

        if (reelData) {
            if (reelData.reelUrl !== loadLastReel()) {
                console.log("🆕 New reel — sending notification");
                await sendDiscordNotification(reelData.reelUrl, reelData.thumbUrl, reelData.caption, true);
                saveLastReel(reelData.reelUrl);
            } else {
                console.log("🟰 No new reel.");
            }
        }

        console.log("✅ Run complete");
    } finally {
        // Close even if something threw mid-run
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

main().catch(err => {
    console.error("❌ Run failed:", err?.message || err);
    process.exit(1);
});
