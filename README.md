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

## Instagram photo/carousel implementation

Instagram photo and carousel posts use a dedicated anonymous public-media GraphQL helper before yt-dlp. The helper uses `curl_cffi` Chrome impersonation, obtains a fresh CSRF cookie, queries the current Polaris media endpoint, extracts `image_versions2.candidates`, and downloads CDN images with the same browser-like TLS fingerprint. This is separate from yt-dlp because current yt-dlp does not reliably extract image-only Instagram carousel entries.

Environment:
- `INSTAGRAM_GRAPHQL_DOC_IDS` — comma-separated public media GraphQL doc IDs. Default: `27128499623469141`.
- `MAX_CAROUSEL_ITEMS` — default 50.

No Instagram credentials or cookies are accepted by the app.


## Google Drive

Public/shared Google Drive links for image and video files are supported. The file must be accessible to the user and have downloading allowed; the app does not bypass Drive permissions or download restrictions. Google Drive provides browser/API download mechanisms for files when the requester has download access.
