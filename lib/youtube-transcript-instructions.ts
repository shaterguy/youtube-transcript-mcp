export const YOUTUBE_TRANSCRIPT_TOOL_DESCRIPTION =
  "Get timed source transcripts for a public YouTube URL or video ID, including a bare URL. Use start_youtube_transcript_job as the single entry: reuse cached transcripts or active jobs, try public captions, then fall back to durable Gemini transcription. Use get_youtube_transcript_job for subsequent results and follow its status guidance. This server returns transcript data and job state; response composition is maintained separately in the analyze-youtube-video skill.";

export const YOUTUBE_SERVER_INSTRUCTIONS = `YouTube transcript acquisition server.
Use start_youtube_transcript_job to start or reuse a video/language job and get_youtube_transcript_job to retrieve that same job.
Only verified complete results contain the full transcript. Preserve jobToken and follow shouldPoll, reason, retryable and nextStatusCheckAt. Never replay an unknown provider POST outcome.
Report writing instructions are maintained separately in the analyze-youtube-video skill: https://chatgpt.com/plugins/plugins_6ae3fcf6b0b081919854a35e1dcb837f.
This server does not author reports or embed report composition policy.`;
