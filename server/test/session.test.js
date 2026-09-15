import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/core/session.js";

test("session exposes its current start time and clears it when stopped", async () => {
  const noop = () => {};
  const session = new Session({
    record: { id: "s1", label: "test", email: "a@example.test", password: "secret", cookie: "", autoStart: false },
    config: {},
    logger: { child: () => ({ info: noop, warn: noop, error: noop }) },
    bus: { emit: noop },
    pluginHost: { startSession: async () => {}, stopSession: async () => {}, instances: new Map(), registry: new Map() },
    baseUrl: "https://example.test",
  });
  session.client.ensureSession = async () => ({});

  await session.start();
  assert.equal(typeof session.toJSON().startedAt, "number");

  await session.stop();
  assert.equal(session.toJSON().startedAt, null);
});
