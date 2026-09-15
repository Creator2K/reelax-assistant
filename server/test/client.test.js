import assert from "node:assert/strict";
import test from "node:test";
import { GameClient } from "../src/core/client.js";

test("signed retries reuse the same idempotency key", async () => {
  const keys = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/api/me")) {
      return Response.json({ player: {} }, { headers: { "x-arcane-request-proof": "renewed-proof" } });
    }

    keys.push(new Headers(options.headers).get("Idempotency-Key"));
    if (keys.length === 1) {
      return Response.json({ error: { code: "SIGNATURE_EXPIRED", message: "expired" } }, { status: 401 });
    }
    return Response.json({ ok: true });
  };

  const client = new GameClient({ baseUrl: "https://example.test", fetchImpl, log: { warn() {} } });
  client.proof = "old-proof";

  await client.request("/api/action", { method: "POST", body: { value: 1 }, idempotent: true });

  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[1], keys[0]);
});
