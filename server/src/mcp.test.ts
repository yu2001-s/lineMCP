import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTIONS } from "./mcp.ts";

test("the server instructions fit in the 2048 characters hosts keep", () => {
	assert.ok(INSTRUCTIONS.length <= 2048, `${INSTRUCTIONS.length} characters`);
});
