const GEMINI_MODEL = "gemini-3.6-flash";
const HTTP_REQUEST_TIMEOUT_MS = 65_000;

const TRANSCRIPTION_PROMPT = `당신은 영상 전용 정밀 전사 엔진이다. 이 공개 YouTube 영상의 음성을 직접 듣고 처음 들리는 발화부터 마지막 발화까지 전부 전사하라.

반드시 지킬 규칙:
1. 요약, 번역, 의역, 문장 다듬기, 내용 재구성, 해설을 하지 않는다.
2. 영상에서 실제로 들리는 언어 그대로 기록한다. 반복 발화, 말더듬, 머뭇거림, 감탄사, 사례, 인용, 광고, 인트로와 아웃트로도 임의로 생략하지 않는다.
3. 들리지 않는 내용을 추측하거나 새로 만들지 않는다. 알아들을 수 없는 부분은 [불명확]으로 표시한다. 의미 있는 웃음·박수·음악 등은 [웃음], [박수], [음악]처럼 표시한다.
4. 화자가 바뀔 때마다 줄을 바꾼다. 이름이 확실하면 이름을 쓰고, 확실하지 않으면 화자 1, 화자 2처럼 일관되게 구분한다.
5. 각 발화 줄을 정확히 '[HH:MM:SS] 화자: 발화' 형식으로 출력한다. 한 화자의 긴 발화에도 최소 30초마다 새 타임스탬프를 넣는다.
6. 제목, URL, 영상 길이, 요약, 목차, 안내 문장, Markdown 코드 블록은 출력하지 않는다. 전사 본문만 출력한다.
7. 영상의 마지막 실제 발화까지 확인하고 전사를 모두 마친다.`;

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export class GeminiTranscriptError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "GeminiTranscriptError";
  }
}

export function isGeminiConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return Boolean(apiKey);
}

export async function transcribeYouTubeWithGemini(canonicalUrl: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new GeminiTranscriptError("GEMINI_API_KEY is not configured.");
  const controller = new AbortController();
  // This is a bounded HTTP request, not a whole background transcription deadline.
  const timeout = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
      {
        method: "POST", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ file_data: { file_uri: canonicalUrl } }, { text: TRANSCRIPTION_PROMPT }] }],
          generationConfig: { maxOutputTokens: 65536, mediaResolution: "MEDIA_RESOLUTION_LOW",
            thinkingConfig: { thinkingLevel: "low" } },
        }),
      }
    );
    const payload = (await response.json().catch(() => ({}))) as GeminiResponse;
    if (!response.ok) {
      throw new GeminiTranscriptError(payload.error?.message || "Gemini HTTP " + response.status, response.status);
    }
    const result = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || "";
    if (!result) throw new GeminiTranscriptError("Gemini returned no transcript; finishReason: " +
      (payload.candidates?.[0]?.finishReason || "unknown"));
    return result.replace(/\r\n/g, "\n");
  } catch (error) {
    if (error instanceof GeminiTranscriptError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GeminiTranscriptError("Gemini single HTTP request timed out; use the resumable background transcription tools.");
    }
    throw new GeminiTranscriptError(error instanceof Error ? error.message : "Unknown Gemini error.");
  } finally { clearTimeout(timeout); }
}
