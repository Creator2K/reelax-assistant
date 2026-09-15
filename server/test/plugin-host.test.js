import assert from "node:assert/strict";
import test from "node:test";
import { PluginHost } from "../src/core/plugin-host.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHost() {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    child: () => ({ info: noop, warn: noop, error: noop }),
  };
  const config = {
    getPluginDefault: () => undefined,
    getPluginState: () => undefined,
  };
  const bus = { on: () => noop };
  return new PluginHost({ config, logger, bus });
}

test("managed one-shot timers are removed after firing", async () => {
  const host = createHost();
  let calls = 0;
  host.register({ id: "timer", name: "timer", onStart: (ctx) => ctx.schedule(5, () => calls++) });
  const session = { id: "s1", client: {} };

  await host.startSession(session);
  await delay(25);

  assert.equal(calls, 1);
  assert.equal(host.getInstance("s1", "timer").timers.size, 0);
  await host.stopSession(session);
});

test("managed one-shot timers do not fire after a session stops", async () => {
  const host = createHost();
  let calls = 0;
  host.register({ id: "timer", name: "timer", onStart: (ctx) => ctx.schedule(20, () => calls++) });
  const session = { id: "s1", client: {} };

  await host.startSession(session);
  await host.stopSession(session);
  await delay(40);

  assert.equal(calls, 0);
});
