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
  const args = [
    "-f", format,
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
    "-o", outputTemplate,
    url
  ];

  try {
    await new Promise((resolve, reject) => {
      const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      p.stderr.on("data", d => {
        stderr += d.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });
      p.on("error", reject);
      p.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `yt-dlp exited ${code}`));
      });
    });

    let files = await fs.promises.readdir(tempDir);
    let mediaFile = files.find(name => /\.mp4$/i.test(name));
    if (!mediaFile) throw new Error("The server did not produce an MP4 file.");

    // Verify the final MP4 actually contains an audio stream. Some sites expose
    // video and audio separately, so a successful download is not enough.
    const filePath = path.join(tempDir, mediaFile);
    let probe = "";
    try {
      probe = await new Promise((resolve, reject) => {
        const p = spawn("ffprobe", [
          "-v", "error",
          "-select_streams", "a:0",
          "-show_entries", "stream=codec_name",
          "-of", "default=noprint_wrappers=1:nokey=1",
          filePath
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        p.stdout.on("data", d => out += d.toString());
        p.stderr.on("data", d => err += d.toString());
        p.on("error", reject);
        p.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err || "ffprobe failed")));
      });
    } catch (_) {
      probe = "";
    }

    if (!probe) {
      throw new Error("The source returned a video without an audio stream. The site may not expose downloadable audio for this post.");
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
    const raw = await runYtDlp([
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      "--skip-download",
      "--socket-timeout", "20",
      "--js-runtimes", "deno",
      "--remote-components", "ejs:github",
      url
    ]);
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
  const { url, quality, audioOnly } = req.body || {};
  if (!validHttpUrl(url)) return res.status(400).json({ error: "Enter a valid URL." });

  try {
    let format;
    if (audioOnly) {
      format = "bestaudio/best";
    } else if (/^\d+p$/.test(String(quality || ""))) {
      const h = Number(String(quality).replace("p", ""));
      // Always select a video-only stream PLUS an audio-only stream.
      // This avoids the common Instagram case where the chosen MP4 contains video only.
      format = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/bestvideo+bestaudio/best`;
    } else {
      // Original/source quality: explicitly merge best video + best audio.
      format = "bestvideo+bestaudio/best";
    }

    const title = String(req.body.title || "instant-download");
    await runDownload(url, format, res, title);
  } catch (e) {
    if (!res.headersSent) {
      const detail = String(e.message || e).replace(/\s+/g, " ").slice(0, 800);
      res.status(500).json({ error: `Download failed. ${detail}` });
    }
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, service: "instant-download" }));

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Instant Download listening on ${PORT}`));
