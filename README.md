# YouTube Transcript MCP

YouTube 공개 자막 추출 및 Gemini 전사 기능을 제공합니다. Termux TMCP와 Vercel 직접 MCP는 같은 코드 경로를 사용합니다.

## 도구

- `check_connection`: 연결 및 설정 점검
- `start_youtube_transcript_job`: 단일 시작 경로입니다. 정규화 영상 ID·언어의 완료 캐시/활성 작업을 재사용하고, yt-dlp 자막을 시도한 뒤 미확보 시 같은 호출에서 Gemini 비동기 전사를 시작합니다. 완료 결과 또는 나중에 조회할 **서명된 jobToken**을 반환합니다.
- `get_youtube_transcript_job`: jobToken으로 구간별 진행 상태를 조회하고, **모든 구간이 성공한 경우에만** 전체 전사를 반환합니다.

### 비동기 전사 예시

1. `start_youtube_transcript_job({url:"https://youtu.be/G-8cDsHLrD0",durationSeconds:1200,chunkSeconds:240})`
2. 반환된 최신 `jobToken`으로 `get_youtube_transcript_job({jobToken:"..."})` 호출
3. 응답 `status`가 `in_progress`이면 이후 상태 조회 때 **새로 반환된 jobToken** 사용 (완료된 구간의 결과는 토큰에 압축 저장돼 다시 조회하지 않음)
4. `completed`일 때만 `transcript`가 존재하고, 구간 전체 병합 결과를 사용합니다. `failed`는 전사 완료로 취급하지 않습니다.

`durationSeconds`는 선택사항입니다. 미입력 시 YouTube Data API(환경변수 `YOUTUBE_DATA_API_KEY`) 또는 YouTube 플레이어 메타데이터에서 길이를 확인합니다. 정확한 영상 길이를 확인하지 못할 경우 **영상 전체를 비동기 처리하되 구간 분할은 수행하지 않습니다**(`segmentation:"whole-video"`). 물리 구간 분할은 Gemini Files API 입력에서만 가능합니다.

YouTube URL 입력은 영상 전체를 단 한 번 제출합니다(`segmentation:"whole-video"`). duration/chunk 힌트가 달라도 같은 영상·언어의 작업을 중복 제출하지 않습니다. Gemini Files API의 `geminiFileUri`를 제공한 입력에만 실제 미디어 구간 클리핑을 적용합니다(`segmentation:"file-clips"`).

구간을 나눌 때 기본 240초 간격이며 인접 구간은 3초 겹칩니다. 겹친 구간의 발화는 누락 방지를 위해 원문 그대로 보존하므로 일부 반복될 수 있습니다. 각 구간의 결과가 생성되었다는 사실만으로 발화의 정확성을 보증하지 않으며 실제 음성 내용과의 검증은 별도 작업입니다.

Google 429/503/5xx 및 일시적 네트워크 오류는 제한된 지수 백오프로 재시도합니다. 완료되지 않은 Gemini 작업의 상태 조회에 429가 발생하면 안내된 재시도 시간을 지키고, 429가 반복되면 기존 Interactions ID를 보존하고 재조회합니다. 이미 전사를 완료한 구간은 서명된 상태 토큰에서 재사용하므로 다시 요청하지 않습니다. Gemini가 failed/cancelled/incomplete를 반환하면 그 상태를 그대로 보고하며 상태 조회가 새 전사 요청으로 바뀌지 않습니다. 토큰 서명 유효기간은 180일이며 Gemini가 보관하는 Interaction 기록은 별도로 만료될 수 있습니다. 토큰을 원본 서버의 최신 응답으로 갱신하여 사용하십시오. 비동기 작업은 Vercel 함수 메모리에 보관하지 않으므로 함수가 재시작되더라도 Google Interactions 측 작업 ID로 조회할 수 있습니다.

## 설정

- `GEMINI_API_KEY` — Gemini 전사 필수
- `YOUTUBE_DATA_API_KEY` — 선택, 영상 길이 조회
- `YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY` — 선택, 토큰 서명 전용 키. 미설정 시 Gemini API 키로 서명합니다.

`npm run type-check`, `npm run test:async`, `npm run build`로 검증합니다. 테스트는 실제 Gemini API 호출을 하지 않습니다.


## Caption engine (yt-dlp)
- Both cloud and Termux use the same source: manually uploaded captions first, then YouTube automatic captions if manual captions are absent in the original/requested language.
- yt-dlp only fetches metadata and timed VTT/SRT subtitle files with --skip-download and --ignore-config; video and audio streams are never downloaded.
- The Termux runtime executes python3 -m yt_dlp; a cloud runtime must provision a supported yt-dlp binary and set YT_DLP_BIN to its executable path.
- A single start falls back to Gemini when usable timed captions cannot be obtained, including yt-dlp execution/transport failures. This does not claim the video has no captions. Private, age-restricted, or unavailable videos are not bypassed.
- Model for Interactions API transcription: gemini-3.6-flash. The async job token retains segment IDs and completed speech; repeated GET 429 does not create a new provider job.


## Termux status polling recovery (v0.3.6-dev1)
- Use `get_youtube_transcript_job({jobToken, readOnly:true})` to inspect an accepted job without allowing another provider POST.
- HTTP 429 is a status-read failure, not proof that the provider is still processing. Inspect `lastHttpStatus`, `lastReadError`, and `lastProviderStatus`; a failed latest read clears stale provider status.
- Honor the full Retry-After minimum. Consecutive GET 429 adds exponential cooldown (30 seconds up to 30 minutes) plus nonnegative jitter; a longer provider minimum always wins. Successful GET resets the counter, and cooldown survives token/store restoration.
- This change does not prove successful real transcription or resolve an external provider quota.



## Explicit job status contract (v0.3.6-dev2)
- Only confirmed processing/queue states use `in_progress`/`queued`. `shouldPoll=true` only for these states.
- GET 429 returns `rate_limited`; other status-read failures return `blocked`. Both preserve the existing interaction and do not prove provider failure. `providerStatus=unknown` distinguishes a failed observation from actual provider state.
- `requires_action`, `failed`, `cancelled`, and `incomplete` remain visible top-level states. Stop automatic waiting whenever `shouldPoll=false`; read `reason`/`error`.
- For an accepted interaction, `retryable` concerns the same status GET only. For a proven pre-submission acquisition or explicitly rejected initial POST, an explicit normal lookup may resume the same job after its lease/cooldown. Unknown POST outcomes are never replayed. `readOnly:true` forbids every provider POST.
- Legacy saved jobs are projected from persisted error/provider evidence without replacing their IDs, attempts, transcript cache, or cooldown. Transient blocked jobs remain explicitly resumable after service restart.
- `readOnly:true` forbids all provider POSTs, including retries; it still saves status observations. No in-process timer polls jobs automatically.


## Single start and complete transcript delivery (v0.3.6-dev3)
- Removed synchronous `get_youtube_transcript`; keep result lookup `get_youtube_transcript_job`.
- Every verified complete result delivers the full transcript, including immediate captions, Gemini completion, cache and legacy stored completion. Noncomplete/error results have no transcript cache metadata.
- Content identity is video ID plus trimmed, lowercase language. Acquisition hints do not create duplicate jobs. Existing v2 signed tokens and stored provider IDs remain valid; legacy records are reused by their explicit video/language metadata.
- Completed durable cache metadata uses `durable-v3`, `durable-local`/`durable-redis`. Local files retain their existing no-expiry behavior. Redis TTL remains 90 days from the latest persisted write; merely reading a completed record does not renew it. This retention is not an overall transcription deadline.
- Legacy Next v3 fetch cache is preserved in the old release, not guessed into the new cache: its body does not record language and its key includes callback identity. Unknown-language entries are not automatically imported.
- There is no whole-job timeout. Individual transport timeouts and 429 status-read failures retain an accepted interaction ID. Unknown POST outcomes are quarantined rather than resubmitted.
- Regression fixtures use no live Gemini requests. Run `npm run test:local` and `npm run type-check`; new tests cover every completion route, legacy reuse, normalized deduplication, fallback, and noncompletion rejection.

### Recovery safety (dev3)
- New jobs persist `acquiring`, original arguments and a 5-minute ownership lease before caption work. The 120-second caption-attempt budget moves to Gemini fallback; neither value expires the whole job. If that process disappears or an API key is temporarily unavailable, the same job can resume because no POST was made.
- Immediately before initial provider submission, CAS changes the stage to `starting`. Unknown POST outcomes retain the old no-replay quarantine. An old release's `starting` record is not retroactively assumed safe to retry.
- Initial POST429 preserves `lastPostError`, HTTP status and Retry-After. Long Retry-After is returned rather than slept inside the request, and no missing-ID retry can run before cooldown. Existing accepted-ID GET recovery stays unchanged.
- Legacy IDs are indexed once per process and matching records are reloaded. Deploy with old writers stopped. Unreadable unrelated legacy records are preserved and reported as degraded legacy deduplication evidence, not deleted or allowed to block unrelated new videos.

## Writing policy separation (v0.3.6-dev4)
- Report composition is maintained in the **analyze-youtube-video** skill and the [YouTube 영상 분석 plugin](https://chatgpt.com/plugins/plugins_6ae3fcf6b0b081919854a35e1dcb837f). Update that skill for writing-rule changes; no TMCP source change, build, or restart is needed.
- The server provides acquisition, cache, durable job recovery, timed transcript data and technical status contracts only. Completed responses no longer carry responsePolicyVersion, responseDirective or responseContract; legacy cached copies of those fields are stripped at delivery time.
- Existing signed tokens, job IDs, saved interactions, cache identity, cooldowns, retry rules and complete-transcript validation remain unchanged. The skill is responsible for composing the final report.
