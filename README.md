# YouTube Transcript MCP

YouTube 공개 자막 추출 및 Gemini 전사 기능을 제공합니다. Termux TMCP와 Vercel 직접 MCP는 같은 코드 경로를 사용합니다.

## 도구

- `check_connection`: 연결 및 설정 점검
- `get_youtube_transcript`: 기존 동기식 전사(호환성 유지). 긴 영상은 요청 제한 시간을 초과할 수 있습니다.
- `start_youtube_transcript_job`: Gemini Interactions API 백그라운드 전사를 시작하고 **서명된 jobToken**을 즉시 반환합니다.
- `get_youtube_transcript_job`: jobToken으로 구간별 진행 상태를 조회하고, **모든 구간이 성공한 경우에만** 전체 전사를 반환합니다.

### 비동기 전사 예시

1. `start_youtube_transcript_job({url:"https://youtu.be/G-8cDsHLrD0",durationSeconds:1200,chunkSeconds:240})`
2. 반환된 최신 `jobToken`으로 `get_youtube_transcript_job({jobToken:"..."})` 호출
3. 응답 `status`가 `in_progress`이면 이후 상태 조회 때 **새로 반환된 jobToken** 사용 (완료된 구간의 결과는 토큰에 압축 저장돼 다시 조회하지 않음)
4. `completed`일 때만 `transcript`가 존재하고, 구간 전체 병합 결과를 사용합니다. `failed`는 전사 완료로 취급하지 않습니다.

`durationSeconds`는 선택사항입니다. 미입력 시 YouTube Data API(환경변수 `YOUTUBE_DATA_API_KEY`) 또는 YouTube 플레이어 메타데이터에서 길이를 확인합니다. 정확한 영상 길이를 확인하지 못할 경우 **영상 전체를 비동기 처리하되 구간 분할은 수행하지 않습니다**(`segmentation:"whole-video"`). 구간 분할 보장이 필요하면 실제 영상 길이를 인자로 전달하십시오.

YouTube URL 입력에서는 Gemini Interactions API의 영상 클리핑 매개변수가 HTTP 400을 반환하므로 영상 전체를 서버에 비동기 제출하고, 출력할 발화의 시간 구간을 프롬프트로 제한합니다(`segmentation:"prompt-scoped"`). **이는 실제 미디어 클리핑이 아니며 각 요청에서 전체 영상을 처리합니다.** Gemini Files API로 업로드된 영상의 `geminiFileUri`와 MIME 타입을 함께 전달하면 해당 업로드 파일의 실제 시간 구간을 잘라 처리합니다(`segmentation:"file-clips"`).

구간을 나눌 때 기본 240초 간격이며 인접 구간은 3초 겹칩니다. 겹친 구간의 발화는 누락 방지를 위해 원문 그대로 보존하므로 일부 반복될 수 있습니다. 각 구간의 결과가 생성되었다는 사실만으로 발화의 정확성을 보증하지 않으며 실제 음성 내용과의 검증은 별도 작업입니다.

Google 429/503/5xx 및 일시적 네트워크 오류는 제한된 지수 백오프로 재시도하고, Gemini 백그라운드 작업이 일시적 오류로 실패한 경우 상태 조회에서 다음 모델로 대체합니다. 토큰은 HMAC 서명돼 있으며 기본 만료 시간은 7일입니다. 토큰을 원본 서버의 최신 응답으로 갱신하여 사용하십시오. 비동기 작업은 Vercel 함수 메모리에 보관하지 않으므로 함수가 재시작되더라도 Google Interactions 측 작업 ID로 조회할 수 있습니다.

## 설정

- `GEMINI_API_KEY` — Gemini 전사 필수
- `YOUTUBE_DATA_API_KEY` — 선택, 영상 길이 조회
- `YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY` — 선택, 토큰 서명 전용 키. 미설정 시 Gemini API 키로 서명합니다.

`npm run type-check`, `npm run test:async`, `npm run build`로 검증합니다. 테스트는 실제 Gemini API 호출을 하지 않습니다.
