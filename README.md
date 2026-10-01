# Instant Download — Railway

Full-stack Node/Express + yt-dlp + FFmpeg media downloader for public/authorized content.

## YouTube

The container installs Deno plus the current `yt-dlp` Python package and the official yt-dlp-recommended `yt-dlp-getpot-wpc` PO-token provider. The provider uses Chromium to mint YouTube WebPoClient tokens when yt-dlp requests them. This can improve compatibility with current YouTube bot/PO-token checks, but YouTube may still reject requests based on IP, video availability, account state, or other platform controls.

The app does not include or accept user account credentials/cookies. Private, members-only, DRM-protected, or otherwise restricted media is not promised to work.

## Deploy

Use Railway with the repository root `/` and Dockerfile builder. Push these files to GitHub and redeploy.


## Image posts
Instagram and Pinterest image posts now use a public OpenGraph image fallback when the video extractor exposes no video formats. Single images download directly; multiple public images are returned as a ZIP.

## YouTube speed
YouTube analysis tries the `web_embedded` client first because it does not require a PO token; it falls back to the PO-token path when needed. YouTube can still be slower when the fallback is required.
