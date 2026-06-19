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

// 5) Semantic retrieval — a query with NO keyword overlap with the tool's text
// ("small picture" vs "Returns a tiny MCP logo image") must still surface
// get-tiny-image at the top. A keyword scorer would find no overlap and fall
// back to the first tool (echo), so this also proves the RAG core is active.
const sem = await client.callTool({
  name: "search_tools",
  arguments: { intent: "show me a small picture", k: 3 },
});
const semHits = JSON.parse(sem.content[0].text);
console.log("[5] search_tools('show me a small picture') ->", semHits.map((h) => `${h.server}.${h.name}`).join(", "));
if (semHits[0]?.name !== "get-tiny-image") {
  throw new Error(`semantic retrieval failed: expected get-tiny-image on top, got ${semHits[0]?.name}`);
}

await client.close();
console.log("\n✅ end-to-end chain OK: client -> router -> downstream (semantic retrieval verified)\n");
process.exit(0);
