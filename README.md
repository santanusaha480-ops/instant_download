# Instant Download — Railway-ready v9

This build keeps the working Pinterest fixes and improves Instagram image-post extraction and YouTube download speed.

## v9 changes
- Instagram photo posts: public Meta Graph oEmbed fallback (tokenless public oEmbed), Instagram embed-page fallback, page metadata fallback.
- Instagram image-only posts no longer depend on yt-dlp returning video formats.
- YouTube analysis/download: `web_embedded` is tried first; the slower PO-token provider path is only used when the fast client cannot handle the video.
- YouTube download format selection prefers MP4 video + M4A audio to avoid unnecessary video recoding.
- Pinterest video/image fixes from v8 are retained, including safe UTF-8 attachment filenames and high-quality image selection.

## Limits
Only public/authorized media is supported. No private-account, members-only, DRM, credential, or cookie bypass is included.
