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


Instagram carousel handling: public image-only posts use a short headless Chromium fallback to let the public Instagram page finish loading carousel metadata. Up to 50 public carousel items are supported by default (`MAX_CAROUSEL_ITEMS`). No account credentials or cookies are used.


### Instagram image posts
The server first queries Instagram's current public shortcode-media response (`xdt_api__v1__media__shortcode__web_info`) and selects the highest-resolution image candidate for every carousel item. The GraphQL document id can be overridden with `INSTAGRAM_GRAPHQL_DOC_ID` when Instagram rotates it. The service does not accept user account credentials or cookies.
