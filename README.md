# Instant Download — Railway v7

Node/Express + yt-dlp + FFmpeg media downloader intended for public/authorized media.

## v7 fixes
- Instagram Reels and video posts continue to use yt-dlp.
- Instagram single-photo posts now use a public-page image fallback instead of requiring yt-dlp video formats.
- Instagram image carousels are collected from public HTML metadata when available and returned as a ZIP.
- Instagram oEmbed thumbnail is used as an additional fallback for public single-photo posts.
- Image downloads send the original post as the HTTP Referer when fetching the CDN image.
- Pinterest public image pins also use the same public-page image fallback.
- YouTube keeps the fast `web_embedded` analysis path and PO-token fallback.

## Important limitation
Current yt-dlp versions can detect Instagram image-only posts but return no video formats for them. This is a known limitation, so the application has a separate public-image extraction path. It cannot access private/login-only/DRM content and does not accept user cookies or credentials.

## Railway
- Root directory: `/`
- Builder: Dockerfile
- Public domain: generate one in Railway
