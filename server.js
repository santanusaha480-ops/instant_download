const express = require("express");
const cors = require("cors");
const path = require("path");
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

function runDownload(args, res, filenameFallback) {
  const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", d => {
    err += d.toString();
    if (err.length > 12000) err = err.slice(-12000);
  });

  res.setHeader("Content-Disposition", `attachment; filename="${filenameFallback.replace(/"/g, "")}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  p.stdout.pipe(res);

  p.on("error", e => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.destroy(e);
  });
  p.on("close", code => {
    if (code !== 0 && !res.headersSent) {
      res.status(400).json({ error: "The source could not be downloaded by the server." });
    }
  });
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
      "--socket-timeout", "15",
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
        qualities.push({ label: q, format_id: f.format_id });
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
    res.status(400).json({
      error: "This URL is unsupported, private, blocked, DRM-protected, or unavailable to the server."
    });
  }
});

app.post("/api/download", async (req, res) => {
  const { url, formatId, quality, audioOnly } = req.body || {};
  if (!validHttpUrl(url)) return res.status(400).json({ error: "Enter a valid URL." });

  // formatId comes from /api/analyze. Never accept arbitrary shell fragments.
  if (formatId && !/^[A-Za-z0-9._+-]+$/.test(String(formatId))) {
    return res.status(400).json({ error: "Invalid format." });
  }

  try {
    let format = formatId;
    if (!format) {
      if (audioOnly) format = "bestaudio";
      else if (/^\d+p$/.test(String(quality || ""))) {
        const h = Number(String(quality).replace("p",""));
        format = `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`;
      } else {
        format = "bestvideo+bestaudio/best";
      }
    }

    // -o - streams the resulting media to the HTTP response.
    // merge-output-format works when FFmpeg is installed in the Railway image.
    const args = [
      "-f", format,
      "--no-playlist",
      "--no-warnings",
      "--merge-output-format", "mp4",
      "--recode-video", "mp4",
      "--socket-timeout", "20",
      "-o", "-"
    ];

    runDownload([...args, url], res, "instant-download.mp4");
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "Download failed." });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, service: "instant-download" }));

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Instant Download listening on ${PORT}`));
