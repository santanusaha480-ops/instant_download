# Instant Download — Railway-ready v8

Full-stack Node/Express + yt-dlp + FFmpeg media downloader for public/authorized media.

## v8 fixes
- Pinterest video downloads: fixes `Invalid character in header content [Content-Disposition]` when a pin title contains emoji or other Unicode characters. Downloads now use RFC 5987 UTF-8 filenames with an ASCII fallback.
- Pinterest image quality: prefers Pinterest `originals` CDN URLs when available instead of 236x/474x/736x preview images, with automatic size fallbacks if the original URL is unavailable.
- Pinterest image downloads validate the returned content type and retry alternate CDN sizes.
- Existing Instagram photo/carousel and YouTube fixes remain.

## Deploy on Railway
- Root directory: `/`
- Builder: Dockerfile
- Push the repository and let Railway redeploy.

## Scope
Only public/authorized media is supported. Private, login-only, DRM-protected, paywalled, or authentication-bypassing downloads are not promised.
