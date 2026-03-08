require("dotenv").config();
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const INSTAGRAM_USERNAME = process.env.IG_USERNAME;
const INSTAGRAM_PASSWORD = process.env.IG_PASSWORD;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TARGET_IG = process.env.IG_TARGET_USERNAME || "sayravr";

const HEADLESS = process.env.HEADLESS === "true";
const MANUAL_LOGIN_MODE = process.env.MANUAL_LOGIN_MODE === "true";

const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "ig_state");
const LAST_POST_FILE = "last_post.json";
const LAST_REEL_FILE = "last_reel.json";

function getFormattedDate() {
    const now = new Date();
    return now.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
}

function saveJson(filePath, obj) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function loadJson(filePath) {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveLastPost(postUrl) {
    saveJson(LAST_POST_FILE, { lastPost: postUrl });
}

function loadLastPost() {
    return loadJson(LAST_POST_FILE)?.lastPost ?? null;
}

function saveLastReel(reelUrl) {
    saveJson(LAST_REEL_FILE, { lastReel: reelUrl });
}

function loadLastReel() {
    return loadJson(LAST_REEL_FILE)?.lastReel ?? null;
}

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

async function saveDebugHtml(page, name = "debug") {
    try {
        const html = await page.content();
        fs.writeFileSync(path.join(__dirname, `${name}.html`), html);
        console.log(`📝 Saved debug HTML: ${name}.html`);
    } catch (err) {
        console.log("⚠️ Failed to save debug HTML:", err.message);
    }
}

async function launchBrowser() {
  const executablePath = await chromium.executablePath();

  return puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ],
    defaultViewport: {
      width: 1366,
      height: 900
    }
  });
}

async function isInstagramLoadError(page) {
    const info = await page.evaluate(() => ({
        title: document.title || "",
        body: document.body?.innerText?.slice(0, 1500) || ""
    }));

    const t = info.title.toLowerCase();
    const b = info.body.toLowerCase();

    return (
        t.includes("seite konnte nicht geladen werden") ||
        t.includes("page couldn't load") ||
        b.includes("seite konnte nicht geladen werden") ||
        b.includes("page couldn't load") ||
        b.includes("something went wrong")
    );
}

async function detectCheckpoint(page) {
    const url = page.url();

    if (
        url.includes("/challenge/") ||
        url.includes("/accounts/suspended/") ||
        url.includes("/checkpoint/")
    ) {
        return true;
    }

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || "");
    const lowered = bodyText.toLowerCase();

    return (
        lowered.includes("suspicious") ||
        lowered.includes("challenge") ||
        lowered.includes("confirm it's you") ||
        lowered.includes("verify") ||
        lowered.includes("checkpoint") ||
        lowered.includes("help us confirm you own this account")
    );
}

async function gotoWithRetries(page, url, tries = 3) {
    let lastErr;

    for (let i = 0; i < tries; i++) {
        try {
            console.log(`🌐 Navigating to ${url} (${i + 1}/${tries})`);
            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 60000
            });

            await sleep(3500);

            if (await isInstagramLoadError(page)) {
                throw new Error("Instagram returned load-error page");
            }

            return;
        } catch (err) {
            lastErr = err;
            console.log(`⚠️ Navigation failed (${i + 1}/${tries}) for ${url}: ${err.message}`);
            await sleep(3000);
        }
    }

    throw lastErr;
}

async function getPageText(page) {
    return page.evaluate(() => document.body?.innerText?.slice(0, 2500) || "");
}

async function pageLooksLoggedIn(page) {
    const currentUrl = page.url();
    const bodyText = (await getPageText(page)).toLowerCase();
    const hasLoginInput = await page.$('input[name="username"]');

    if (hasLoginInput) return false;
    if (currentUrl.includes("/accounts/login")) return false;
    if (bodyText.includes("log in") && bodyText.includes("sign up")) return false;

    return true;
}

async function loginInstagram(page) {
    console.log("🔐 Logging into Instagram...");

    await gotoWithRetries(page, "https://www.instagram.com/accounts/login/");

    await page.waitForSelector('input[name="username"]', { timeout: 20000 });

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
        throw new Error("Login led to checkpoint (manual verification needed).");
    }

    if (!(await pageLooksLoggedIn(page))) {
        await saveDebugHtml(page, "login_failed");
        throw new Error("Login failed or session not accepted.");
    }

    console.log("✅ Logged in.");
}

async function ensureLoggedIn(page) {
    await gotoWithRetries(page, "https://www.instagram.com/");

    if (await detectCheckpoint(page)) {
        throw new Error("Instagram checkpoint detected (manual verification needed).");
    }

    if (await pageLooksLoggedIn(page)) {
        console.log("✅ Session appears logged in.");
        return;
    }

    if (MANUAL_LOGIN_MODE) {
        throw new Error("Manual login mode enabled, but session is not logged in yet.");
    }

    await loginInstagram(page);
}

async function runManualLoginMode(page) {
    console.log("🛠️ MANUAL_LOGIN_MODE is ON");
    console.log("🌐 Opening Instagram login page...");
    await gotoWithRetries(page, "https://www.instagram.com/accounts/login/");

    console.log("👉 Please log in manually in the opened browser window.");
    console.log("👉 Complete 2FA/challenge if Instagram asks.");
    console.log("👉 After login, wait until Instagram home/profile loads.");

    for (let i = 0; i < 120; i++) {
        await sleep(2000);

        if (await detectCheckpoint(page)) {
            console.log("⚠️ Checkpoint/challenge still active. Finish it manually.");
            continue;
        }

        if (await pageLooksLoggedIn(page)) {
            console.log("✅ Manual login detected. Session should now be saved in ig_state.");
            return true;
        }
    }

    throw new Error("Timed out waiting for manual login to complete.");
}

async function fetchInstagramJson(page, url) {
    return page.evaluate(async (targetUrl) => {
        try {
            const response = await fetch(targetUrl, {
                method: "GET",
                credentials: "include",
                headers: {
                    "accept": "*/*",
                    "x-requested-with": "XMLHttpRequest"
                }
            });

            const text = await response.text();

            let data = null;
            try {
                data = JSON.parse(text);
            } catch (_) { }

            return {
                ok: response.ok,
                status: response.status,
                text,
                data
            };
        } catch (err) {
            return {
                ok: false,
                status: 0,
                text: String(err),
                data: null
            };
        }
    }, url);
}

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

function isPinnedItem(item) {
    return Boolean(item?.is_pinned || item?.pinned_for_users?.length);
}

function buildMediaUrl(item, isReel = false) {
    if (!item?.code) return null;
    return isReel
        ? `https://www.instagram.com/reel/${item.code}/`
        : `https://www.instagram.com/p/${item.code}/`;
}

async function getFeedItems(page, username) {
    const apiUrl = `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=12`;

    const result = await fetchInstagramJson(page, apiUrl);

    if (!result.ok || !result.data) {
        console.log("⚠️ Feed API failed:", result.status);
        console.log("⚠️ Feed API raw response preview:", (result.text || "").slice(0, 500));
        return null;
    }

    const items = Array.isArray(result.data.items) ? result.data.items : [];
    console.log(`📦 Feed API returned ${items.length} items`);
    return items;
}

async function getMediaPageData(page, mediaUrl, isReel = false) {
    await gotoWithRetries(page, mediaUrl);
    await sleep(5000);

    const mediaData = await page.evaluate((reelMode) => {
        const oldPostImage =
            document.querySelector('img.x5yr21d')?.src || null;

        const articleImg =
            document.querySelector('article img')?.src || null;

        const metaOgImage =
            document.querySelector('meta[property="og:image"]')?.content || null;

        const metaTwitterImage =
            document.querySelector('meta[name="twitter:image"]')?.content || null;

        const captionElement = document.querySelector('h1[dir="auto"]');
        const domCaption = captionElement ? captionElement.innerText.trim() : null;

        const metaCaption =
            document.querySelector('meta[property="og:description"]')?.content || null;

        let caption = domCaption || "No caption available";

        if (!domCaption && metaCaption) {
            const parts = metaCaption.split(":");
            if (parts.length > 1) {
                parts.shift();
                caption = parts.join(":").trim();
            } else {
                caption = metaCaption.trim();
            }
        }

        const imageUrl = reelMode
            ? (metaOgImage || metaTwitterImage || articleImg || null)
            : (oldPostImage || articleImg || metaOgImage || metaTwitterImage || null);

        return {
            imageUrl,
            caption,
            debug: {
                oldPostImage,
                articleImg,
                metaOgImage,
                metaTwitterImage,
                usedMode: reelMode ? "reel" : "post"
            }
        };
    }, isReel);

    console.log("🖼️ Media extraction debug:", mediaData.debug);
    return mediaData;
}

async function getLatestPost(page, username) {
    const profileUrl = `https://www.instagram.com/${username}/`;
    console.log(`📸 Visiting profile: ${profileUrl}`);
    await gotoWithRetries(page, profileUrl);

    if (await detectCheckpoint(page)) {
        throw new Error("Checkpoint detected while visiting profile.");
    }

    const items = await getFeedItems(page, username);

    let postUrl = null;
    let latestPost = null;

    if (items && items.length) {
        latestPost = items.find(item => {
            const isReel = item?.product_type === "clips";
            return !isReel && !isPinnedItem(item) && item?.code;
        });

        if (latestPost) {
            postUrl = buildMediaUrl(latestPost, false);
            console.log("📌 Latest Post via API:", postUrl);
        }
    }

    if (!postUrl) {
        console.log("⚠️ API post lookup returned nothing. Falling back to DOM scan.");
        await sleep(4000);

        postUrl = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll("a"))
                .map(a => a.href)
                .filter(href => href.includes("/p/"));

            return [...new Set(links)][0] || null;
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
        function getLargestFromSrcset(srcset) {
            if (!srcset) return null;

            const candidates = srcset
                .split(",")
                .map(part => part.trim())
                .map(part => {
                    const [url, width] = part.split(" ");
                    return {
                        url,
                        width: parseInt(width, 10) || 0
                    };
                })
                .filter(x => x.url);

            if (!candidates.length) return null;

            candidates.sort((a, b) => b.width - a.width);
            return candidates[0].url;
        }

        const img =
            document.querySelector("div._aagu._aato div._aagv img.x5yr21d") ||
            document.querySelector("div._aagv img.x5yr21d") ||
            document.querySelector("img.x5yr21d");

        const image =
            getLargestFromSrcset(img?.getAttribute("srcset") || "") ||
            img?.src ||
            null;

        const captionElement = document.querySelector('h1[dir="auto"]');
        const domCaption = captionElement ? captionElement.innerText.trim() : null;

        const metaCaption =
            document.querySelector('meta[property="og:description"]')?.content || null;

        let caption = domCaption || "No caption available";

        if (!domCaption && metaCaption) {
            const parts = metaCaption.split(':');
            if (parts.length > 1) {
                parts.shift();
                caption = parts.join(':').trim();
            } else {
                caption = metaCaption.trim();
            }
        }

        return { image, caption };
    });

    return {
        postUrl,
        imageUrl: postData.image || (latestPost ? extractImageFromItem(latestPost) : null),
        caption: postData.caption
    };
}

async function getLatestReel(page, username) {
    const reelsUrl = `https://www.instagram.com/${username}/reels/`;
    console.log(`🎬 Visiting Reels Page: ${reelsUrl}`);
    await gotoWithRetries(page, reelsUrl);

    if (await detectCheckpoint(page)) {
        throw new Error("Checkpoint detected while visiting reels page.");
    }

    const items = await getFeedItems(page, username);
    console.log("🎬 Feed API returned items for reel check:", items?.length || 0);

if (items?.length) {
    console.log("🎬 First 5 reel-check items:");
    items.slice(0, 5).forEach((item, i) => {
        console.log(i, {
            code: item?.code,
            product_type: item?.product_type,
            media_type: item?.media_type
        });
    });
}

    if (items && items.length) {
        const reelItems = items.filter(item =>
            item?.product_type === "clips" &&
            item?.code &&
            !isPinnedItem(item)
        );

        const latestReel = reelItems[0] || null;

        if (latestReel) {
            const reelUrl = buildMediaUrl(latestReel, true);
            console.log("📌 Latest Reel via API:", reelUrl);

            const mediaPageData = await getMediaPageData(page, reelUrl, true);

            return {
                reelUrl,
                thumbUrl: mediaPageData.imageUrl || extractImageFromItem(latestReel),
                caption: mediaPageData.caption || extractCaptionFromItem(latestReel)
            };
        }
    }

    console.log("⚠️ API reel lookup returned nothing. Falling back to DOM scan.");
    await sleep(4000);

    console.log("🎬 DOM reel links found:", await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
        .map(a => a.href)
        .filter(href => href.includes("/reel/"))
        .slice(0, 10)
));

    const reelUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll("a"))
            .map(a => a.href)
            .filter(href => href.includes("/reel/"));

        const unique = [...new Set(links)];
        return unique.length > 3 ? unique[3] : unique[0] || null;
    });

    if (!reelUrl) {
        console.log("❌ No reel found.");
        await saveDebugHtml(page, "reels_debug");
        return null;
    }

    const mediaPageData = await getMediaPageData(page, reelUrl, true);

    return {
        reelUrl,
        thumbUrl: mediaPageData.imageUrl,
        caption: mediaPageData.caption
    };
}

async function sendDiscordNotification(url, mediaUrl, caption, isReel = false) {
    if (!url) return;

    const formattedDate = getFormattedDate();

    const embed = {
        title: `New Instagram ${isReel ? "Reel" : "Post"} from ${TARGET_IG}!`,
        description: caption || "",
        url,
        fields: [{ name: "🔗 Link", value: `[Click Here](${url})` }],
        color: 0x8a2be2,
        footer: { text: `${TARGET_IG} | instagram.com • ${formattedDate}` }
    };

    if (mediaUrl) {
        embed.image = { url: mediaUrl };
    }

    const payload = {
        content: `@everyone ${url}`,
        embeds: [embed],
        allowed_mentions: { parse: ["everyone"] }
    };

    await axios.post(DISCORD_WEBHOOK_URL, payload);
    console.log("✅ Notification sent:", url);
}

async function main() {
    ensureEnv();
    console.log("🚀 IG checker run started");
    console.log(`🧠 HEADLESS=${HEADLESS}`);
    console.log(`🧠 MANUAL_LOGIN_MODE=${MANUAL_LOGIN_MODE}`);
    console.log(`🧠 STATE_DIR=${STATE_DIR}`);

    const browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    try {
        if (MANUAL_LOGIN_MODE) {
            await runManualLoginMode(page);
            console.log("✅ Manual login mode finished. You can now set MANUAL_LOGIN_MODE=false.");
            return;
        }

        await ensureLoggedIn(page);

        const postData = await getLatestPost(page, TARGET_IG).catch(async err => {
            console.log("⚠️ Post check failed:", err.message);
            await saveDebugHtml(page, "post_failure");
            return null;
        });

        if (postData) {
            const lastPosted = loadLastPost();
            if (postData.postUrl !== lastPosted) {
                console.log("🆕 New post detected");
                await sendDiscordNotification(
                    postData.postUrl,
                    postData.imageUrl,
                    postData.caption,
                    false
                );
                saveLastPost(postData.postUrl);
            } else {
                console.log("🟰 No new post found.");
            }
        }

        const reelData = await getLatestReel(page, TARGET_IG).catch(async err => {
            console.log("⚠️ Reel check failed:", err.message);
            await saveDebugHtml(page, "reel_failure");
            return null;
        });

        if (reelData) {
            const lastReel = loadLastReel();
            if (reelData.reelUrl !== lastReel) {
                console.log("🆕 New reel detected");
                await sendDiscordNotification(
                    reelData.reelUrl,
                    reelData.thumbUrl,
                    reelData.caption,
                    true
                );
                saveLastReel(reelData.reelUrl);
            } else {
                console.log("🟰 No new reel found.");
            }
        }

        console.log("✅ Done");
    } finally {
        await page.close().catch(() => { });
        await browser.close().catch(() => { });
    }
}

main().catch(err => {
    console.error("❌ Run failed:", err?.message || err);
    process.exit(1);
});


