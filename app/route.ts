export async function GET() {
  return new Response("YouTube Transcript MCP is running.", {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
