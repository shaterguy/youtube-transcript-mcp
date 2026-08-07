export const YOUTUBE_RESPONSE_POLICY_VERSION = "youtube-content-v1.1" as const;

export const YOUTUBE_TRANSCRIPT_TOOL_DESCRIPTION =
  "Use this whenever the user provides a public YouTube URL or video ID and wants the video's content understood, organized, summarized, analyzed, or transcribed. A bare YouTube URL is sufficient reason to call this tool. This is the single transcript-acquisition path for YouTube: do not pre-call, supplement, or replace it with yt-dlp, metadata scrapers, or other transcript tools. After the transcript is obtained, external research tools may be used only for fact-checking and additional analysis. Unless the user explicitly asks for raw transcript/captions only, follow this server's YouTube response instructions and the returned responseContract when composing the final answer.";

export const YOUTUBE_SERVER_INSTRUCTIONS = `YouTube 콘텐츠 처리 전용 규칙 (${YOUTUBE_RESPONSE_POLICY_VERSION})

1. 자막 확보
- 사용자가 공개 YouTube URL 또는 11자리 video ID를 제공하면 get_youtube_transcript를 YouTube 자막 확보의 단일 경로로 사용한다.
- 자막 확보 전에 yt-dlp, 메타데이터 조회기, 다른 전사 도구를 사전·보조·대체 호출하지 않는다.
- 자막 확보가 끝난 뒤 사실검증과 추가분석을 위해 웹검색이나 다른 외부 도구를 사용하는 것은 허용한다.

2. 기본 응답 모드
- 사용자가 원문 자막·캡션 자체만 명시적으로 요청한 경우에는 자막을 그대로 제공하는 요청을 따른다.
- 그 외에는 반환된 transcript를 원문으로 삼아 콘텐츠를 정리·분석한다.
- 명백한 오타와 전사 오류는 자연스럽게 바로잡되 별도로 언급하지 않는다.
- MCP는 자막과 응답 구성 규칙만 제공한다. [개요], [내용정리], [사실검증], [추가분석]의 실제 문장과 분석 내용은 MCP가 미리 생성하지 않으며, transcript를 받은 호스트 LLM이 작성한다.

3. 출력 구조
- 기본 대제목은 [개요], [내용정리], 필요한 경우 [사실검증], [추가분석] 순서로 구성한다.
- [개요]는 주제, 영상 길이처럼 확인 가능한 기본 정보, 관련 인물 등 개괄 정보만 제공한다. 핵심결론·핵심내용·한눈에 보기 등의 선요약을 두지 않는다.
- [내용정리]에서는 원문의 관점·주장·의도·전제·근거·사례·결론을 보존한다. 외부 자료·평가·반박·사실검증·확장 해석을 섞지 않는다. 반복되거나 흩어진 발언은 의미 단위로 통합하고, 발언 순서에 얽매이지 말고 주제와 논리 흐름에 맞게 재배열한다. '화자는', '영상에서는', '기사에서는'처럼 원문의 존재를 독자에게 알리는 메타서술을 쓰지 않고, 정제된 보고서형 확정문으로 재구성한다.
- [사실검증]에서는 원문의 명백하고 실질적인 오류만 바로잡는다. 사소한 표현 차이나 대략적인 방향이 맞는 내용은 넣지 않는다. 명백한 오류가 없으면 이 섹션을 생략한다.
- [추가분석]에서는 주제의 맥락, 배경, 심화 내용, 이해에 도움이 되는 추가 지식과 인사이트를 제시한다. 원문 정리와 외부 분석을 명확히 분리한다.

4. 타임스탬프
- 영상 콘텐츠를 정리할 때 주요 문장 또는 의미 단위 끝에 실제 발언 위치와 대응하는 클릭 가능한 YouTube 타임스탬프를 붙인다.
- '클릭 가능한 타임스탬프'는 단순한 12:34 또는 [12:34] 텍스트가 아니라 반드시 Markdown 링크 자체여야 한다. 형식은 [MM:SS](<canonicalUrl>&t=<seconds>s) 또는 1시간 이상 영상에서는 [HH:MM:SS](<canonicalUrl>&t=<seconds>s)로 출력한다.
- 예: [12:34](https://www.youtube.com/watch?v=VIDEO_ID&t=754s). 타임스탬프 링크를 코드 블록이나 인라인 코드로 감싸지 않는다.
- transcript에 존재하거나 그 transcript로부터 신뢰성 있게 대응시킬 수 있는 실제 시각만 사용한다. 타임스탬프를 추정하거나 만들어내지 않는다.
- 표시 텍스트만 있는 타임스탬프, URL이 없는 타임스탬프, 일반 텍스트 URL 뒤에 별도 시각을 적는 방식은 이 규칙을 충족하지 않는다.

5. 충돌 처리
- 사용자가 이번 요청에서 더 구체적인 출력 형식이나 범위를 명시하면 그 요청을 우선한다.
- 이 서버 규칙은 YouTube 콘텐츠 처리에만 적용하며, 일반적인 비-YouTube 답변 형식까지 확장하지 않는다.`;

export const YOUTUBE_RESPONSE_CONTRACT = {
  policyVersion: YOUTUBE_RESPONSE_POLICY_VERSION,
  scope: "youtube-content-only",
  transcriptAcquisition: {
    tool: "get_youtube_transcript",
    exclusivePath: true,
    otherTranscriptToolsAllowed: false,
    externalResearchAfterTranscriptAllowed: true,
  },
  contentGeneration: {
    performedByMcp: false,
    performedByHostLlm: true,
    mcpProvidesTranscriptAndResponseRulesOnly: true,
  },
  defaultMode: "organized-analysis",
  rawTranscriptOnlyWhenExplicitlyRequested: true,
  transcriptCleanup: {
    silentlyCorrectObviousTyposAndTranscriptionErrors: true,
  },
  sections: {
    overview: {
      label: "[개요]",
      required: true,
      rule: "Provide only overview information such as topic, verifiable video length, and relevant people. Do not front-load a key-conclusion or TL;DR summary.",
    },
    content: {
      label: "[내용정리]",
      required: true,
      rule: "Preserve the source viewpoint, claims, intent, assumptions, evidence, examples, and conclusions; consolidate repetition and reorder by logical topic flow; exclude external evaluation, rebuttal, fact-checking, and extended interpretation; avoid meta narration such as '화자는' or '영상에서는'.",
    },
    factCheck: {
      label: "[사실검증]",
      required: false,
      omitWhenNoMaterialError: true,
      rule: "Correct only clear and material factual errors in the source.",
    },
    additionalAnalysis: {
      label: "[추가분석]",
      required: true,
      rule: "Add broader context, background, deeper analysis, and useful related knowledge while keeping it separate from the source-content reconstruction.",
    },
  },
  timestamps: {
    clickable: true,
    markdownLinkRequired: true,
    rejectPlainTextTimestamp: true,
    attachToMajorMeaningUnits: true,
    useActualSpeechPositionsOnly: true,
    neverInvent: true,
    displayTextFormat: "MM:SS or HH:MM:SS",
    markdownLinkTemplate: "[<displayTimestamp>](<canonicalUrl>&t=<seconds>s)",
  },
} as const;
