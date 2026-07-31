export async function GET() {
  return new Response(
    "YouTube Transcript MCP v0.2.0 is running with get_youtube_transcript.",
    {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    }
  );
}
