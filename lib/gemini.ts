/** Configuration probe only. Acquisition uses durable Gemini Interactions jobs. */
export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}
