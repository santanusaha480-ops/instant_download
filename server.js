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

async function runDownload(url, format, res, filenameFallback) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "instant-download-"));
  const outputTemplate = path.join(tempDir, "media.%(ext)s");
  const baseArgs = [
    "--no-playlist",
    "--no-warnings",
    "--merge-output-format", "mp4",
    "--recode-video", "mp4",
    "--force-overwrites",
    "--socket-timeout", "30",
    "--retries", "3",
    "--fragment-retries", "3",
    "--js-runtimes", "deno",
    "--remote-components", "ejs:github",
    ...youtubeClientArgs(url),
    "-o", outputTemplate,
  ];

  async function execute(selector) {
    const args = ["-f", selector, ...baseArgs, url];
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
      await execute(format);
    } catch (firstError) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw firstError;
    }

    let filePath = await findMp4WithAudio();
    if (!filePath) {
      // Clean failed/partial output and ask yt-dlp for the best format that
      // already contains both video and the audio belonging to this post.
      for (const name of await fs.promises.readdir(tempDir)) {
        await fs.promises.rm(path.join(tempDir, name), { force: true }).catch(() => {});
      }
      await execute("best[hasvid][hasaud]/best");
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
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp4"`);

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
    try {
      raw = await runYtDlp(analyzeArgs);
    } catch (firstError) {
      // If YouTube rejects the normal client with a bot-check, retry only
      // with its supported embedded client. This works only for videos that
      // YouTube makes embeddable; private/member-only content remains blocked.
      const msg = String(firstError.message || firstError);
      if (isYouTubeUrl(url) && /sign in to confirm|not a bot|bot|captcha|confirm you/i.test(msg)) {
        raw = await runYtDlp([
          "--dump-single-json",
          "--no-playlist",
          "--no-warnings",
          "--skip-download",
          "--socket-timeout", "20",
          "--js-runtimes", "deno",
          "--remote-components", "ejs:github",
          ...youtubeClientArgs(url, true),
          url
        ]);
      } else {
        throw firstError;
      }
    }
    const info = JSON.parse(raw);

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
      qualities: qualities.slice(0, 12),
      formats: formats.slice(0, 80)
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
    let format;
    if (audioOnly) {
      format = "bestaudio";
    } else if (/^\d+p$/.test(String(quality || ""))) {
      const h = Number(String(quality).replace("p", ""));
      // Explicitly request video + the best audio stream exposed by THIS
      // Instagram post, with a combined A/V fallback at the same height.
      format = `bestvideo*[height<=${h}]+?bestaudio/best[height<=${h}]/best`;
    } else if (formatId) {
      // The format id comes from this exact post's extractor result. Always
      // pair video-only formats with audio from the same post. Do not use
      // external/generated audio.
      format = /^\d+$/.test(String(formatId || "")) && hasAudio === true
        ? String(formatId)
        : `${String(formatId || "bestvideo*")}+?bestaudio/best`;
    } else {
      format = "bestvideo*+?bestaudio/best";
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
