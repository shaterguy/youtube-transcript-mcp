import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler(
  async (server) => {
    server.registerTool(
      "check_connection",
      {
        title: "Check MCP connection",
        description:
          "Use this when you need to verify that the YouTube transcript MCP server is reachable.",
        inputSchema: z.object({}),
      },
      async () => ({
        content: [
          {
            type: "text",
            text: "YouTube Transcript MCP connection is working.",
          },
        ],
      })
    );
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 60,
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
