const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SECONDS = Number(process.env.MAX_MEDIA_SECONDS || 900);
const MAX_CAROUSEL_ITEMS = Number(process.env.MAX_CAROUSEL_ITEMS || 50);

app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

function validHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
  } catch {
    return false;
  }
}

function isInstagramUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch { return false; }
}

function isPinterestUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "pinterest.com" || host.endsWith(".pinterest.com") || host === "pin.it";
  } catch { return false; }
}

function isImagePostUrl(value) {
  return isInstagramUrl(value) || isPinterestUrl(value);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function setAttachmentFilename(res, filename, ext = "") {
  const raw = String(filename || "instant-download").trim() || "instant-download";
  const withExt = ext && !raw.toLowerCase().endsWith(ext.toLowerCase()) ? `${raw}${ext}` : raw;
  const ascii = withExt
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/[\\/:*?"<>|;\r\n]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 150) || `instant-download${ext}`;
  const encoded = encodeURIComponent(withExt).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
}

async function extractInstagramOembedImage(url) {
  if (!isInstagramUrl(url)) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const endpoint = `https://www.instagram.com/oembed/?url=${encodeURIComponent(url)}`;
    const r = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "Accept": "application/json,text/plain,*/*"
      }
    });
    if (!r.ok) return [];
    const data = await r.json();
    return data?.thumbnail_url ? [data.thumbnail_url] : [];
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function pinterestOriginalUrl(value) {
  try {
    const u = new URL(value);
    if (!/pinimg\.com$/i.test(u.hostname)) return value;
    u.pathname = u.pathname.replace(/\/(?:originals|1200x|736x|564x|474x|400x|236x|170x)\//i, "/originals/");
    return u.toString();
  } catch (_) { return value; }
}

function rankImageUrl(value, width = 0, height = 0) {
  const u = pinterestOriginalUrl(value);
  const w = Number(width) || 0, h = Number(height) || 0;
  return { url: u, score: w * h + (/\/originals\//i.test(u) ? 1e12 : 0) };
}


function instagramPostCode(value) {
  try {
    const u = new URL(value);
    const m = u.pathname.match(/\/(?:p|reel|reels|tv)\/([^/]+)/i);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

async function extractInstagramGraphOembed(url) {
  if (!isInstagramUrl(url)) return [];
  const endpoints = [
    "https://graph.facebook.com/v26.0/instagram_oembed",
    "https://graph.facebook.com/v25.0/instagram_oembed"
  ];
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const r = await fetch(`${endpoint}?url=${encodeURIComponent(url)}&maxwidth=1080`, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
          "Accept": "application/json,text/plain,*/*"
        }
      });
      if (!r.ok) continue;
      const data = await r.json();
      const out = [];
      if (data?.thumbnail_url) out.push(data.thumbnail_url);
      if (typeof data?.html === "string") {
        const re = /https?:\\?\/\\?\/[^\"'<>\s]+/g;
        for (const m of data.html.matchAll(re)) out.push(m[0].replace(/\\\//g, "/"));
      }
      if (out.length) return [...new Set(out)];
    } catch (_) {
      // Try the next public oEmbed API version.
    } finally { clearTimeout(timer); }
  }
  return [];
}

async function extractInstagramEmbedImages(url) {
  if (!isInstagramUrl(url)) return [];
  const code = instagramPostCode(url);
  if (!code) return [];
  const candidates = [
    `https://www.instagram.com/p/${encodeURIComponent(code)}/embed/captioned/`,
    `https://www.instagram.com/p/${encodeURIComponent(code)}/embed/`
  ];
  for (const endpoint of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const r = await fetch(endpoint, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": url
        }
      });
      if (!r.ok) continue;
      const html = await r.text();
      const out = [];
      const add = (v) => {
        if (!v) return;
        let x = String(v).replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=");
        x = decodeHtml(x);
        try { x = new URL(x, endpoint).toString(); } catch (_) { return; }
        if (/^https?:\/\//i.test(x) && /(?:cdninstagram|fbcdn|scontent)/i.test(x)) {
          if (!out.includes(x)) out.push(x);
        }
      };
      const patterns = [
        /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi,
        /"display_url"\s*:\s*"((?:\\.|[^"\\])+)"/g,
        /"thumbnail_src"\s*:\s*"((?:\\.|[^"\\])+)"/g,
        /<img[^>]+src=["']([^"']+)["'][^>]*>/gi,
        /background-image:\s*url\((?:["']?)(https?:[^)"']+)/gi
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) && out.length < 30) add(m[1]);
      }
      if (out.length) return out;
    } catch (_) {
      // Try the next embed URL.
    } finally { clearTimeout(timer); }
  }
  return [];
}

async function extractInstagramBrowserImages(url) {
  if (!isInstagramUrl(url)) return [];
  return await new Promise((resolve) => {
    const args = [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--disable-extensions", "--disable-background-networking", "--no-first-run",
      "--no-default-browser-check", "--disable-blink-features=AutomationControlled",
      "--virtual-time-budget=12000", "--dump-dom", url
    ];
    const p = spawn(process.env.YTDLP_CHROME_PATH || "/usr/bin/chromium", args, { stdio: ["ignore", "pipe", "pipe"] });
    let html = "", settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) {} finish([]); }, 22000);
    p.stdout.on("data", d => {
      html += d.toString();
      if (html.length > 12000000) html = html.slice(-12000000);
    });
    p.on("error", () => finish([]));
    p.on("close", () => {
      const out = [];
      const add = (value) => {
        if (!value) return;
        let x = String(value).replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=").replace(/\\u0025/gi, "%");
        x = decodeHtml(x);
        try { x = JSON.parse('"' + x.replace(/"/g, '\\"') + '"'); } catch (_) {}
        try { x = new URL(x, url).toString(); } catch (_) { return; }
        if (/^https?:\/\//i.test(x) && /(?:cdninstagram|fbcdn|scontent)/i.test(x) && !out.includes(x)) out.push(x);
      };
      const patterns = [
        /"display_url"\s*:\s*"((?:\\.|[^"\\])+)"/g,
        /"image_versions2"\s*:\s*\{[\s\S]{0,5000}?"url"\s*:\s*"((?:\\.|[^"\\])+)"/g,
        /"thumbnail_src"\s*:\s*"((?:\\.|[^"\\])+)"/g,
        /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi,
        /<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi,
        /<img[^>]+srcset=["']([^"']+)["'][^>]*>/gi
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) && out.length < MAX_CAROUSEL_ITEMS) {
          if (re.source.includes("srcset")) {
            for (const part of String(m[1]).split(",")) add(part.trim().split(/\s+/)[0]);
          } else add(m[1]);
        }
        if (out.length >= MAX_CAROUSEL_ITEMS) break;
      }
      finish([...new Set(out)]);
    });
  });
}

async function extractPublicImageUrls(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache"
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const images = [];
    const add = (value) => {
      if (!value) return;
      let u = String(value);
      // Instagram serializes URLs inside JSON with escaped slashes/unicode.
      u = u.replace(/\\\\\//g, "/").replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=").replace(/\\u0025/gi, "%");
      try { u = JSON.parse('"' + u.replace(/"/g, '\\"') + '"'); } catch (_) {}
      u = decodeHtml(u);
      try {
        const absolute = new URL(u, url).toString();
        if (!/^https?:\/\//i.test(absolute)) return;
        if (!/\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i.test(absolute) && !/cdninstagram|fbcdn|scontent/i.test(absolute)) return;
        if (!images.includes(absolute)) images.push(absolute);
      } catch (_) {}
    };

    // Standard metadata used by many public Instagram/Pinterest pages.
    const metaRe = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = metaRe.exec(html)) && images.length < 20) add(m[1]);
    const reverseRe = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi;
    while ((m = reverseRe.exec(html)) && images.length < 20) add(m[1]);

    // Instagram\'s public HTML/embedded JSON commonly contains these fields.
    const patterns = [
      /"display_url"\s*:\s*"((?:\\.|[^"\\])+)"/g,
      /"thumbnail_src"\s*:\s*"((?:\\.|[^"\\])+)"/g,
      new RegExp('"url"\\s*:\\s*"(https?:\\\\/(?:\\\\/)?(?:scontent|cdninstagram|fbcdn)[^"]+)"', 'g'),
      new RegExp('https?:\\/\\/(?:scontent|cdninstagram|fbcdn)[^"\\\\\\s]+', 'g')
    ];
    for (const re of patterns) {
      while ((m = re.exec(html)) && images.length < 20) add(m[1] || m[0]);
    }

    // JSON-LD can contain the main image for a single public post.
    const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    while ((m = ldRe.exec(html)) && images.length < 20) {
      try {
        const obj = JSON.parse(m[1]);
        const stack = Array.isArray(obj) ? obj : [obj];
        for (const item of stack) {
          const image = item && item.image;
          if (typeof image === "string") add(image);
          else if (Array.isArray(image)) image.forEach(add);
          else if (image && typeof image.url === "string") add(image.url);
        }
      } catch (_) {}
    }
    return images.slice(0, MAX_CAROUSEL_ITEMS);
  } finally {
    clearTimeout(timer);
  }
}

// YouTube has recently changed which player clients require bot/PO-token
// checks. yt-dlp documents web_embedded as a supported client for videos that
// are embeddable. We use it as a fallback; this does not authenticate or
// bypass private/member-only content.
function youtubeClientArgs(url, embeddedOnly = false) {
  if (!isYouTubeUrl(url)) return [];
  const clients = embeddedOnly ? "web_embedded" : "web,mweb,web_embedded";
  return [
    "--extractor-args", `youtube:player_client=${clients}`,
    "--extractor-args", `youtubepot-wpc:browser_path=${process.env.YTDLP_CHROME_PATH || "/usr/bin/chromium"}`
  ];
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => stdout += d);
    p.stderr.on("data", d => stderr += d);
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `yt-dlp exited ${code}`)));
  });
}

function imageFetchCandidates(value) {
  const base = pinterestOriginalUrl(value);
  if (!isPinterestUrl(value) && !/pinimg\.com$/i.test(new URL(value).hostname || "")) return [value];
  const out = [base];
  try {
    const u = new URL(base);
    if (/\/originals\//i.test(u.pathname)) {
      for (const size of ["1200x", "736x", "564x", "474x"]) {
        out.push(new URL(u.toString().replace(/\/originals\//i, `/${size}/`)).toString());
      }
    }
  } catch (_) {}
  return [...new Set(out)];
}

async function runImageDownload(imageUrls, res, filenameFallback, refererUrl = null) {
  const urls = [...new Set((imageUrls || []).filter(validHttpUrl))].slice(0, MAX_CAROUSEL_ITEMS);
  if (!urls.length) throw new Error("No public image was found in this post.");
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instant-images-"));
  const safeName = String(filenameFallback || "instant-image")
    .replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 120) || "instant-image";
  try {
    const files = [];
    for (let i = 0; i < urls.length; i++) {
      let saved = false;
      let lastError = null;
      for (const candidate of imageFetchCandidates(urls[i])) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          const r = await fetch(candidate, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", ...(refererUrl ? { "Referer": refererUrl } : {}) } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0].toLowerCase();
          if (!type.startsWith("image/")) throw new Error(`Unexpected content type ${type}`);
          const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/gif" ? "gif" : "jpg";
          const file = path.join(tempDir, `${String(i + 1).padStart(2, "0")}.${ext}`);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < 1000) throw new Error("Image response was too small");
          await fs.promises.writeFile(file, buf);
          files.push(file);
          saved = true;
          break;
        } catch (e) {
          lastError = e;
        } finally { clearTimeout(timer); }
      }
      if (!saved) throw new Error(`Could not download image ${i + 1}${lastError ? `: ${lastError.message}` : ""}`);
    }
    if (files.length === 1) {
      const ext = path.extname(files[0]).toLowerCase() || ".jpg";
      const stat = await fs.promises.stat(files[0]);
      res.setHeader("Content-Type", ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg");
      res.setHeader("Content-Length", stat.size);
      setAttachmentFilename(res, safeName, ext);
      return res.sendFile(files[0], async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {}); });
    }
    const zipPath = path.join(tempDir, `${safeName}.zip`);
    await new Promise((resolve, reject) => {
      const p = spawn("zip", ["-q", zipPath, ...files], { cwd: tempDir, stdio: ["ignore", "pipe", "pipe"] });
      let err = ""; p.stderr.on("data", d => err += d.toString());
      p.on("error", reject); p.on("close", code => code === 0 ? resolve() : reject(new Error(err || "zip failed")));
    });
    const stat = await fs.promises.stat(zipPath);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", stat.size);
    setAttachmentFilename(res, safeName, ".zip");
    res.sendFile(zipPath, async () => { await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {}); });
  } catch (e) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function runDownload(url, format, res, filenameFallback) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instant-download-"));
  const outputTemplate = path.join(tempDir, "media.%(ext)s");
  const commonArgs = [
    "--no-playlist",
    "--no-warnings",
    "--merge-output-format", "mp4",
    "--force-overwrites",
    "--socket-timeout", isYouTubeUrl(url) ? "18" : "30",
    "--retries", isYouTubeUrl(url) ? "2" : "3",
    "--fragment-retries", isYouTubeUrl(url) ? "2" : "3",
    "--js-runtimes", "deno",
    "--remote-components", "ejs:github",
    "-o", outputTemplate,
  ];

  async function execute(selector, youtubeFast = false) {
    const ytArgs = isYouTubeUrl(url) ? youtubeClientArgs(url, youtubeFast) : [];
    const args = ["-f", selector, ...commonArgs, ...ytArgs, url];
    return await new Promise((resolve, reject) => {
      const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "", stdout = "";
      p.stdout.on("data", d => { stdout += d.toString(); });
      p.stderr.on("data", d => {
        stderr += d.toString();
        if (stderr.length > 16000) stderr = stderr.slice(-16000);
      });
      p.on("error", reject);
      p.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout || `yt-dlp exited ${code}`)));
    });
  }

  async function findMp4WithAudio() {
    const files = await fs.promises.readdir(tempDir);
    for (const name of files.filter(n => /\.mp4$/i.test(n))) {
      const filePath = path.join(tempDir, name);
      try {
        const probe = await new Promise((resolve, reject) => {
          const p = spawn("ffprobe", [
            "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name,channels,duration",
            "-of", "json", filePath
          ], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "", err = "";
          p.stdout.on("data", d => out += d.toString());
          p.stderr.on("data", d => err += d.toString());
          p.on("error", reject);
          p.on("close", code => code === 0 ? resolve(JSON.parse(out || "{}")) : reject(new Error(err || "ffprobe failed")));
        });
        if (Array.isArray(probe.streams) && probe.streams.length > 0) return filePath;
      } catch (_) {}
    }
    return null;
  }

  try {
    // The selected format and its companion audio are always extracted from
    // the SAME source URL. We never generate or substitute an audio track.
    // First use the requested selector. If it produces a video without an
    // audio stream, retry with the site's best combined A/V representation.
    try {
      // YouTube: try the no-PO-token embedded client first. It is substantially
      // faster when the video is embeddable. Fall back to the PO-token clients
      // only if the fast path cannot download this particular video.
      await execute(format, isYouTubeUrl(url));
    } catch (firstError) {
      if (!isYouTubeUrl(url)) throw firstError;
      for (const name of await fs.promises.readdir(tempDir)) {
        await fs.promises.rm(path.join(tempDir, name), { recursive: true, force: true }).catch(() => {});
      }
      await execute(format, false);
    }

    let filePath = await findMp4WithAudio();
    if (!filePath) {
      // Clean failed/partial output and ask yt-dlp for the best format that
      // already contains both video and the audio belonging to this post.
      for (const name of await fs.promises.readdir(tempDir)) {
        await fs.promises.rm(path.join(tempDir, name), { force: true }).catch(() => {});
      }
      await execute("best[hasvid][hasaud]/best", false);
      filePath = await findMp4WithAudio();
    }

    if (!filePath) {
      throw new Error("Instagram did not expose an audio stream for this post. The server will not invent or substitute audio.");
    }

    const stat = await fs.promises.stat(filePath);
    const safeName = String(filenameFallback || "instant-download")
      .replace(/[\\/:*?"<>|\r\n]/g, "_")
      .slice(0, 150) || "instant-download";

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    setAttachmentFilename(res, safeName, ".mp4");

    res.sendFile(filePath, async (err) => {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (err && !res.headersSent) res.status(500).json({ error: "Could not send the downloaded video." });
    });
  } catch (e) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) {
      const detail = String(e.message || e).replace(/\s+/g, " ").slice(0, 800);
      res.status(400).json({ error: `Download failed. ${detail}` });
    } else {
      res.destroy(e);
    }
  }
}

app.post("/api/analyze", async (req, res) => {
  const { url } = req.body || {};
  if (!validHttpUrl(url)) return res.status(400).json({ error: "Enter a valid http/https URL." });

  try {
    const analyzeArgs = [
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      "--skip-download",
      "--socket-timeout", "20",
      "--js-runtimes", "deno",
      "--remote-components", "ejs:github",
      ...youtubeClientArgs(url),
      url
    ];

    let raw;
    if (isYouTubeUrl(url)) {
      // Fast path: embedded client does not require a PO token and is much
      // quicker. If the video is not embeddable, fall back to the PO-token path.
      try {
        raw = await runYtDlp([
          "--dump-single-json", "--no-playlist", "--no-warnings", "--skip-download",
          "--socket-timeout", "12", "--js-runtimes", "deno", "--remote-components", "ejs:github",
          ...youtubeClientArgs(url, true), url
        ]);
      } catch (_) {
        raw = await runYtDlp(analyzeArgs);
      }
    } else {
      try {
        raw = await runYtDlp(analyzeArgs);
      } catch (firstError) {
        // Image-only Instagram/Pinterest posts can be exposed as image metadata
        // rather than video formats. We handle those with a public OpenGraph image fallback below.
        if (!isImagePostUrl(url)) throw firstError;
        raw = null;
      }
    }
    const info = raw ? JSON.parse(raw) : { title: "Image post", thumbnail: null, formats: [] };

    if (isImagePostUrl(url)) {
      let imageUrls = [];
      if (raw) {
        const candidates = [
          ...(Array.isArray(info.thumbnails) ? info.thumbnails.map(t => rankImageUrl(t?.url, t?.width, t?.height)) : []),
          ...((Array.isArray(info.entries) ? info.entries : []).flatMap(e => [
            ...(Array.isArray(e?.thumbnails) ? e.thumbnails.map(t => rankImageUrl(t?.url, t?.width, t?.height)) : []),
            ...(e?.thumbnail ? [rankImageUrl(e.thumbnail)] : [])
          ])),
          ...(info.thumbnail ? [rankImageUrl(info.thumbnail)] : [])
        ];
        candidates.sort((a, b) => b.score - a.score);
        imageUrls = candidates.map(x => x.url);
      }
      // Always inspect the public page as a second source. This is important
      // for Instagram photo posts/carousels because current yt-dlp can detect
      // the post but return no video formats for image-only entries.
      const graphOembedImages = isInstagramUrl(url) ? await extractInstagramGraphOembed(url).catch(() => []) : [];
      const embedImages = isInstagramUrl(url) ? await extractInstagramEmbedImages(url).catch(() => []) : [];
      const pageImages = await extractPublicImageUrls(url).catch(() => []);
      const browserImages = isInstagramUrl(url) ? await extractInstagramBrowserImages(url).catch(() => []) : [];
      const legacyOembedImages = await extractInstagramOembedImage(url);
      imageUrls = [...new Set([
        ...browserImages,
        ...embedImages,
        ...pageImages,
        ...imageUrls,
        ...graphOembedImages,
        ...legacyOembedImages
      ].map(pinterestOriginalUrl))].slice(0, MAX_CAROUSEL_ITEMS);
      const hasVideo = (info.formats || []).some(f => f.url && f.vcodec && f.vcodec !== "none");
      if (!hasVideo && imageUrls.length) {
        return res.json({
          title: info.title || "Image post", thumbnail: imageUrls[0], duration: null,
          uploader: info.uploader || info.channel || null, webpage_url: info.webpage_url || url,
          extractor: info.extractor_key || info.extractor || (isInstagramUrl(url) ? "Instagram" : "Pinterest"),
          media_type: "image", image_urls: imageUrls,
          qualities: [{ label: imageUrls.length > 1 ? `Download ${imageUrls.length} images` : "Download image", format_id: "image", has_audio: false, has_video: false }],
          formats: []
        });
      }
    }

    if (info.duration && Number(info.duration) > MAX_SECONDS) {
      return res.status(413).json({ error: `Media is longer than the ${MAX_SECONDS}-second server limit.` });
    }

    const formats = (info.formats || [])
      .filter(f => f.url && (f.vcodec !== "none" || f.acodec !== "none"))
      .map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.height}p` : null),
        height: f.height || 0,
        fps: f.fps || null,
        filesize: f.filesize || f.filesize_approx || null,
        has_video: f.vcodec && f.vcodec !== "none",
        has_audio: f.acodec && f.acodec !== "none",
        vcodec: f.vcodec,
        acodec: f.acodec,
        abr: f.abr || null,
        tbr: f.tbr || null
      }))
      .sort((a,b) => (b.height || 0) - (a.height || 0));

    const qualities = [];
    const seen = new Set();
    for (const f of formats) {
      const q = f.has_video ? (f.height ? `${f.height}p` : "video") : "audio";
      if (!seen.has(q)) {
        seen.add(q);
        qualities.push({
          label: q,
          format_id: f.format_id,
          has_audio: Boolean(f.has_audio),
          has_video: Boolean(f.has_video)
        });
      }
    }

    res.json({
      title: info.title || "Media",
      thumbnail: info.thumbnail || null,
      duration: info.duration || null,
      uploader: info.uploader || info.channel || null,
      webpage_url: info.webpage_url || url,
      extractor: info.extractor_key || info.extractor || "unknown",
      qualities: qualities.slice(0, 20),
      formats: formats.slice(0, 100)
    });
  } catch (e) {
    const detail = String(e.message || e).replace(/\s+/g, " ").slice(0, 500);
    res.status(400).json({
      error: `The source could not be analyzed. ${detail}`
    });
  }
});

app.post("/api/download", async (req, res) => {
  const { url, formatId, quality, audioOnly, hasAudio } = req.body || {};
  if (!validHttpUrl(url)) return res.status(400).json({ error: "Enter a valid URL." });

  if (formatId && !/^[A-Za-z0-9._+\-]+$/.test(String(formatId))) {
    return res.status(400).json({ error: "Invalid format." });
  }

  try {
    if (req.body.mediaType === "image") {
      const imageUrls = Array.isArray(req.body.imageUrls) ? req.body.imageUrls : [];
      if (!imageUrls.length) return res.status(400).json({ error: "No image was found for this post." });
      await runImageDownload(imageUrls, res, String(req.body.title || "instant-image"), url);
      return;
    }
    let format;
    if (audioOnly) {
      format = "bestaudio";
    } else if (/^\d+p$/.test(String(quality || ""))) {
      const h = Number(String(quality).replace("p", ""));
      // Explicitly request video + the best audio stream exposed by THIS
      // Instagram post, with a combined A/V fallback at the same height.
      format = isYouTubeUrl(url)
        ? `bestvideo*[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]`
        : `bestvideo*[height<=${h}]+?bestaudio/best[height<=${h}]/best`;
    } else if (formatId) {
      // The format id comes from this exact post's extractor result. Always
      // pair video-only formats with audio from the same post. Do not use
      // external/generated audio.
      format = /^\d+$/.test(String(formatId || "")) && hasAudio === true
        ? String(formatId)
        : `${String(formatId || "bestvideo*")}+?bestaudio/best`;
    } else {
      format = isYouTubeUrl(url)
        ? "bestvideo*[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        : "bestvideo*+?bestaudio/best";
    }

    const title = String(req.body.title || "instant-download");
    await runDownload(url, format, res, title);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: "Download failed." });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, service: "instant-download" }));

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Instant Download listening on ${PORT}`));
