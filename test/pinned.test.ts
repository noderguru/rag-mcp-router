import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedToolName, jsonSchemaToZodShape } from "../src/pinned.js";
import type { ToolHit } from "../src/retriever.js";

test("pinnedToolName sanitizes server.name into a valid MCP tool name", () => {
  // The dot separator is not allowed in MCP tool names → becomes "_"; hyphens stay.
  assert.equal(pinnedToolName("github", "create-pull-request"), "github_create-pull-request");
  // Every disallowed character is replaced.
  assert.equal(pinnedToolName("my.server", "do/thing"), "my_server_do_thing");
  assert.match(pinnedToolName("a b", "c:d"), /^[A-Za-z0-9_-]+$/);
});

test("jsonSchemaToZodShape maps properties and marks required vs optional", () => {
  const schema: ToolHit["inputSchema"] = {
    type: "object",
    properties: { title: { type: "string" }, count: { type: "number" } },
    required: ["title"],
  };
  const shape = jsonSchemaToZodShape(schema);
  assert.deepEqual(Object.keys(shape).sort(), ["count", "title"]);
  assert.equal(shape.title.isOptional(), false, "required field is not optional");
  assert.equal(shape.count.isOptional(), true, "non-required field is optional");
});

test("jsonSchemaToZodShape turns a string enum into a Zod enum", () => {
  const schema: ToolHit["inputSchema"] = {
    type: "object",
    properties: { color: { type: "string", enum: ["red", "blue"] } },
    required: ["color"],
  };
  const shape = jsonSchemaToZodShape(schema);
  assert.equal(shape.color.safeParse("red").success, true);
  assert.equal(shape.color.safeParse("green").success, false);
});

test("jsonSchemaToZodShape handles an empty or missing schema", () => {
  assert.deepEqual(jsonSchemaToZodShape(undefined as unknown as ToolHit["inputSchema"]), {});
  assert.deepEqual(jsonSchemaToZodShape({ type: "object" } as ToolHit["inputSchema"]), {});
});
