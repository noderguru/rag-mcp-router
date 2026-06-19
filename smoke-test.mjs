// End-to-end smoke test: client -> rag-mcp-router -> downstream (server-everything)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke-test", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--config", "test.config.json"],
});

await client.connect(transport);

// 1) Client should see ONLY the 3 facade tools, not the downstream's tools.
const { tools } = await client.listTools();
console.log("\n[1] facade tools:", tools.map((t) => t.name).join(", "));

// 2) list_servers
const servers = await client.callTool({ name: "list_servers", arguments: {} });
console.log("[2] list_servers:", servers.content[0].text.replace(/\s+/g, " "));

// 3) search_tools — should surface downstream tools by intent
const found = await client.callTool({ name: "search_tools", arguments: { intent: "echo a message back", k: 3 } });
const hits = JSON.parse(found.content[0].text);
console.log("[3] search_tools('echo...') ->", hits.map((h) => `${h.server}.${h.name}`).join(", "));

// 4) call_tool — proxy a real downstream call end to end
const echoed = await client.callTool({
  name: "call_tool",
  arguments: { server: "everything", name: "echo", arguments: { message: "router-works" } },
});
console.log("[4] call_tool(echo) ->", echoed.content[0].text);

await client.close();
console.log("\n✅ end-to-end chain OK: client -> router -> downstream\n");
process.exit(0);
