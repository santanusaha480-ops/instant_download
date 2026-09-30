# Instant Download

Railway-ready Node/Express media downloader using yt-dlp, FFmpeg and Deno.

## Instagram audio behavior
For an Instagram post/Reel, the downloader uses only streams exposed by the same post URL. It does not generate or substitute an audio track. Video formats are selected with yt-dlp's conditional `+?bestaudio` behavior so a format that already contains the post audio is not given a duplicate audio stream. FFmpeg merges separate video/audio streams into MP4 when needed.

Use only content you own or are authorized to download. Platform restrictions still apply.
