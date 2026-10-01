# Instant Download

Railway-ready Node/Express media downloader using yt-dlp, FFmpeg and Deno.

## Instagram audio behavior
For an Instagram post/Reel, the downloader uses only streams exposed by the same post URL. It does not generate or substitute an audio track. Video formats are selected with yt-dlp's conditional `+?bestaudio` behavior so a format that already contains the post audio is not given a duplicate audio stream. FFmpeg merges separate video/audio streams into MP4 when needed.

Use only content you own or are authorized to download. Platform restrictions still apply.


### YouTube availability note

YouTube currently applies changing bot checks and Proof of Origin (PO) token requirements to some player clients. This build uses yt-dlp's supported `default,web_embedded,-android_vr` client configuration and, when a bot-check error is detected during analysis, retries with `web_embedded`. The embedded client only works for videos that YouTube makes embeddable; private, members-only, age/account-restricted, or otherwise unavailable content may still fail. yt-dlp documents that some YouTube clients require PO tokens and that `web_embedded` is limited to embeddable videos.
