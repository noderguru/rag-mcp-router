import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/dispatch.js";
import type { Conn } from "../src/downstream.js";

/** Build a connected fake Conn whose client.callTool is stubbed. */
function fakeConn(name: string, callTool: (req: unknown) => Promise<unknown>): Conn {
  return {
    name,
    spec: { command: "noop" },
    client: { callTool } as unknown as Conn["client"],
    tools: [],
    status: "connected",
  };
}

test("dispatch returns an error for an unknown server", async () => {
  const res = await dispatch([], "ghost", "x", {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /unknown server "ghost"/);
});

test("dispatch passes through the modern content shape unchanged", async () => {
  const payload = { content: [{ type: "text", text: "hi" }] };
  const conn = fakeConn("s", async () => payload);
  const res = await dispatch([conn], "s", "echo", { message: "hi" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.content, payload.content);
});

test("dispatch normalizes the legacy { toolResult } shape into content", async () => {
  const conn = fakeConn("s", async () => ({ toolResult: { value: 42 } }));
  const res = await dispatch([conn], "s", "compute", {});
  assert.equal(res.content[0].type, "text");
  assert.deepEqual(JSON.parse(res.content[0].text), { value: 42 });
});

test("dispatch wraps a thrown downstream error", async () => {
  const conn = fakeConn("s", async () => {
    throw new Error("boom");
  });
  const res = await dispatch([conn], "s", "broken", {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /s\.broken failed: boom/);
});

test("dispatch reports a clear error when a dead server can't reconnect", async () => {
  const dead: Conn = {
    name: "dead",
    spec: { command: "rag-mcp-no-such-binary-xyz" },
    client: { callTool: async () => ({}) } as unknown as Conn["client"],
    tools: [],
    status: "disconnected",
  };
  const res = await dispatch([dead], "dead", "x", {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /server "dead" is down/);
});
