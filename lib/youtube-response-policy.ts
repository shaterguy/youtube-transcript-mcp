export const YOUTUBE_RESPONSE_POLICY_VERSION = "youtube-content-v1.2.1" as const;

export const YOUTUBE_TRANSCRIPT_TOOL_DESCRIPTION =
  "Use this whenever the user provides a public YouTube URL or video ID and wants the video's content understood, organized, summarized, analyzed, or transcribed. A bare YouTube URL is sufficient reason to call this tool. This is the single transcript-acquisition path for YouTube: do not pre-call, supplement, or replace it with yt-dlp, metadata scrapers, or other transcript tools. After the transcript is obtained, external research tools may be used only for fact-checking and additional analysis. Unless the user explicitly asks for raw transcript/captions only, the host LLM must assimilate the transcript into direct report prose rather than retell what a speaker said, and must follow this server's YouTube response instructions and the returned responseContract when composing the final answer.";

export const YOUTUBE_FINAL_RESPONSE_DIRECTIVE =
  "FINAL RESPONSE RULE: Assimilate the transcript into standalone report prose; do not retell what the speaker/video said, explained, claimed, mentioned, or discussed. Write the substantive propositions directly. Every YouTube timestamp must be a clickable Markdown link placed only AFTER the completed sentence or paragraph it supports, never before the content, in a heading, or on a standalone line. The MCP supplies transcript and rules only; the host LLM writes the actual report." as const;

export const YOUTUBE_SERVER_INSTRUCTIONS = `YouTube 콘텐츠 처리 전용 규칙 (${YOUTUBE_RESPONSE_POLICY_VERSION})

1. 자막 확보
- 사용자가 공개 YouTube URL 또는 11자리 video ID를 제공하면 get_youtube_transcript를 YouTube 자막 확보의 단일 경로로 사용한다.
- 자막 확보 전에 yt-dlp, 메타데이터 조회기, 다른 전사 도구를 사전·보조·대체 호출하지 않는다.
- 자막 확보가 끝난 뒤 사실검증과 추가분석을 위해 웹검색이나 다른 외부 도구를 사용하는 것은 허용한다.

2. 기본 응답 모드와 역할분리
- 사용자가 원문 자막·캡션 자체만 명시적으로 요청한 경우에는 자막 자체를 제공하는 요청을 따른다.
- 그 외에는 반환된 transcript를 원문으로 삼아 콘텐츠를 정리·분석한다.
- 명백한 오타와 전사 오류는 자연스럽게 바로잡되 별도로 언급하지 않는다.
- MCP는 자막과 응답 구성 규칙만 제공한다. [개요], [내용정리], [사실검증], [추가분석]의 실제 문장과 분석 내용은 MCP가 미리 생성하지 않으며, transcript를 받은 호스트 LLM이 작성한다.

3. 보고서형 직접 서술
- [내용정리]의 목적은 영상이나 화자의 말을 독자에게 전달·중계하는 것이 아니라, transcript의 의미 내용을 충분히 소화한 뒤 독립적인 보고서 본문으로 재구성하는 것이다.
- 화자·영상·기사·발표자를 전달자로 세우지 않는다. 문장의 주어는 가능한 한 실제 주제·개념·사건·수치·논리관계가 되어야 한다.
- 다음과 같은 전달자·인용체는 금지한다: '화자는 ~라고 말했습니다', '~라고 설명했습니다', '~라고 주장했습니다', '영상에서는 ~를 다룹니다', '영상에 따르면', '발표자는', '출연자는', '그는 이어서', '저자는 ~라고 말합니다'. 같은 기능의 변형 표현도 쓰지 않는다.
- 대신 내용을 직접 명제화한다. 예: '금리 하락은 장기채 가격 상승 요인입니다.', '이 제도의 핵심 문제는 계약경계의 재설정 여부입니다.'처럼 보고서 자체가 내용을 설명하도록 쓴다.
- 원문의 관점·주장·의도·전제·근거·사례·결론은 보존하되, 그것을 '누가 말했다'는 전달 프레임으로 보존하지 않는다.
- 인물의 신원이나 발언 주체 자체가 분석상 필수인 경우에만 인물을 사실관계로 언급할 수 있다. 그 경우에도 단순한 발언 전달 동사('말했다', '설명했다', '주장했다' 등)를 반복적인 서술 골격으로 사용하지 않는다.

4. 출력 구조
- 기본 대제목은 [개요], [내용정리], 필요한 경우 [사실검증], [추가분석] 순서로 구성한다.
- [개요]는 주제, 영상 길이처럼 확인 가능한 기본 정보, 관련 인물 등 개괄 정보만 제공한다. 핵심결론·핵심내용·한눈에 보기 등의 선요약을 두지 않는다.
- [내용정리]에서는 반복되거나 흩어진 발언을 의미 단위로 통합하고, 발언 순서에 얽매이지 말고 주제와 논리 흐름에 맞게 재배열한다. 외부 자료·평가·반박·사실검증·확장 해석을 섞지 않는다.
- [사실검증]에서는 원문의 명백하고 실질적인 오류만 바로잡는다. 사소한 표현 차이나 대략적인 방향이 맞는 내용은 넣지 않는다. 명백한 오류가 없으면 이 섹션을 생략한다.
- [추가분석]에서는 주제의 맥락, 배경, 심화 내용, 이해에 도움이 되는 추가 지식과 인사이트를 제시한다. 원문 정리와 외부 분석을 명확히 분리한다.

5. 타임스탬프
- 영상 콘텐츠를 정리할 때 주요 문장 또는 의미 단위에 실제 발언 위치와 대응하는 클릭 가능한 YouTube 타임스탬프를 붙인다.
- 타임스탬프는 반드시 해당 내용을 먼저 완결한 뒤 그 문장 또는 문단의 맨 끝에 배치한다. 종결 문장부호 뒤 한 칸을 띄우고 링크를 붙이는 형식을 기본으로 한다.
- 문장 앞, 문단 앞, 불릿 앞, 제목 앞·뒤, 소제목 바로 아래, 또는 독립된 단독 줄에 타임스탬프를 두지 않는다.
- 올바른 예: '금리 하락은 장기채 가격 상승 요인입니다. [12:34](https://www.youtube.com/watch?v=VIDEO_ID&t=754s)'
- 잘못된 예: '[12:34](...) 금리 하락은 장기채 가격 상승 요인입니다.' 또는 '[12:34](...)\n금리 하락은 ...'
- '클릭 가능한 타임스탬프'는 단순한 12:34 또는 [12:34] 텍스트가 아니라 반드시 Markdown 링크 자체여야 한다. 형식은 [MM:SS](<canonicalUrl>&t=<seconds>s) 또는 1시간 이상 영상에서는 [HH:MM:SS](<canonicalUrl>&t=<seconds>s)로 출력한다.
- 타임스탬프 링크를 코드 블록이나 인라인 코드로 감싸지 않는다.
- transcript에 존재하거나 그 transcript로부터 신뢰성 있게 대응시킬 수 있는 실제 시각만 사용한다. 타임스탬프를 추정하거나 만들어내지 않는다.
- 같은 의미 단위 안에서는 대표 시각 1개를 우선하며, 불필요하게 모든 문장에 타임스탬프를 반복하지 않는다.

6. 충돌 처리
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
  composition: {
    mode: "source-assimilated-report",
    reportStyleRequired: true,
    transcriptRetellingForbidden: true,
    attributionNarrationForbidden: true,
    sourceViewpointPreservedWithoutAttributionFrame: true,
    rule: "Assimilate the transcript into standalone report prose. State the substantive content directly; do not narrate that a speaker/video said, explained, argued, mentioned, or discussed it.",
    negativeExamples: [
      "화자는 금리가 내려갈 것이라고 말했습니다.",
      "영상에서는 계약경계 문제를 설명합니다.",
      "발표자는 시장이 과열됐다고 주장했습니다.",
    ],
    positiveExamples: [
      "금리 하락 가능성이 커지고 있습니다.",
      "계약경계의 핵심 쟁점은 재설정 여부입니다.",
      "시장은 과열 구간에 진입했다는 판단입니다.",
    ],
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
      rule: "Write source-assimilated report prose, not transcript retelling. Preserve the source viewpoint, claims, intent, assumptions, evidence, examples, and conclusions; consolidate repetition and reorder by logical topic flow; exclude external evaluation, rebuttal, fact-checking, and extended interpretation; do not use speaker/video attribution as the narrative frame.",
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
    placement: "end-of-content-unit",
    prefixPlacementForbidden: true,
    standalonePlacementForbidden: true,
    headingPlacementForbidden: true,
    afterTerminalPunctuation: true,
    attachToMajorMeaningUnits: true,
    oneRepresentativeTimestampPerMeaningUnitPreferred: true,
    useActualSpeechPositionsOnly: true,
    neverInvent: true,
    displayTextFormat: "MM:SS or HH:MM:SS",
    markdownLinkTemplate: "<content sentence or paragraph>. [<displayTimestamp>](<canonicalUrl>&t=<seconds>s)",
  },
} as const;
