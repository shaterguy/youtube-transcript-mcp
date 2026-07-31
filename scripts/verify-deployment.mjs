import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint =
  process.env.MCP_URL ?? "https://youtube-transcript-mcp-peach.vercel.app/mcp";
const testVideo =
  process.env.TEST_VIDEO_URL ?? "https://www.youtube.com/watch?v=qsjc7kfWffw";
const maximumAttempts = 18;
const retryDelayMs = 10_000;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function textFromResult(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
  let client;
  try {
    client = new Client({
      name: "youtube-transcript-mcp-verifier",
      version: "0.2.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    await client.connect(transport);

    const toolList = await client.listTools();
    const toolNames = toolList.tools.map((tool) => tool.name);
    if (!toolNames.includes("get_youtube_transcript")) {
      throw new Error(
        `Deployment does not advertise get_youtube_transcript yet. Tools: ${toolNames.join(", ")}`
      );
    }

    const result = await client.callTool({
      name: "get_youtube_transcript",
      arguments: {
        url: testVideo,
        language: "ko-KR",
      },
    });
    const text = textFromResult(result);
    if (result.isError) {
      throw new Error(text || "The transcript tool returned an MCP error.");
    }
    if (text.length < 1_000) {
      throw new Error(
        `Transcript response was unexpectedly short: ${text.length} characters.`
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          endpoint,
          tools: toolNames,
          transcriptResponseCharacters: text.length,
        },
        null,
        2
      )
    );
    await client.close();
    process.exit(0);
  } catch (error) {
    if (client) {
      await client.close().catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Attempt ${attempt}/${maximumAttempts} failed: ${message}`);
    if (attempt === maximumAttempts) {
      process.exit(1);
    }
    await sleep(retryDelayMs);
  }
}
