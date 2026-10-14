export async function GET() {
  return new Response(
    "YouTube Transcript MCP v0.3.6-dev1 is running with Gemini fallback.",
    {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    }
  );
}
