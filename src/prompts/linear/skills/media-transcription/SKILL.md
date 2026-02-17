---
name: media-transcription
description: Transcribe audio/video attachments and use the transcript to answer questions.
criteria: Use when the user asks about media content, transcription, or shares audio/video.
tools: transcribe_media_from_attachment
---

Use `transcribe_media_from_attachment` to transcribe audio or video files from their asset URL.

- Pass the direct asset URL (e.g. from a Linear attachment or comment).
- Optionally provide `context` with background info (names, topics, jargon) to improve transcription accuracy.
- After receiving the transcript, use it to answer the user's question or summarize the content.
