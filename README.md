# Instant Download — Railway backend

## What this adds
- Node.js + Express API
- FFmpeg inside the deployment image
- yt-dlp for public/authorized sources supported by yt-dlp
- `/api/analyze` returns metadata and available formats
- `/api/download` streams the selected result to the browser
- No account/login required
- Railway/Docker ready

## Important scope
This server is intended for media the user owns or is authorized to download.
It does not bypass DRM, paywalls, private accounts, authentication, or access controls.
Some platforms (especially music streaming services) do not expose downloadable media through a public URL/API. A source selector in the UI does not make those sources downloadable.

## Local test
Requires Docker:
docker build -t instant-download .
docker run -p 3000:3000 instant-download

Then open http://localhost:3000

## Railway
1. Put this project in a GitHub repository.
2. Railway -> New Project -> Deploy from GitHub Repo.
3. Railway will detect the Dockerfile.
4. No PORT variable is required; Railway supplies PORT.
5. After deployment, open the generated public domain.
6. Test `/api/health`.

## Production notes
For a public downloader, add rate limiting, per-IP quotas, request timeouts, logging, abuse monitoring, and a queue/worker architecture before exposing it broadly.


## YouTube support
The Docker image includes Deno and yt-dlp EJS support. Current yt-dlp releases require a JavaScript runtime plus yt-dlp-ejs for full YouTube extraction. Some YouTube formats/features can still require platform-issued tokens or access that the server cannot manufacture.


### Audio fix
The download endpoint now detects video-only formats (common on Instagram) and explicitly adds `bestaudio`, then lets FFmpeg mux/re-encode the result to MP4 before sending it to the browser. This avoids returning a video-only stream without sound.


## Instagram audio handling
The downloader now treats audio as part of the same source post. For Instagram video downloads it requests the selected video together with the best audio stream exposed by that exact Instagram post, then uses FFmpeg to produce the final MP4. It also runs `ffprobe` on the final file and refuses to return a silent MP4 if no audio stream is present. It does not generate, replace, or download unrelated audio.

If Instagram/yt-dlp exposes the post as video-only with no accessible audio stream, the server reports that condition instead of silently returning a video without sound.
