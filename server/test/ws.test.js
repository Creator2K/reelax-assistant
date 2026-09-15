import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import WebSocket from "ws";
import { WsHub } from "../src/api/ws.js";

function connectForSessions(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for sessions snapshot"));
    }, 1000);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "sessions") return;
      clearTimeout(timer);
      resolve({ ws, message });
    });
    ws.on("error", reject);
  });
}

test("every new websocket client receives an initial sessions snapshot", async () => {
  const server = http.createServer();
  const noop = () => {};
  const hub = new WsHub({
    server,
    authToken: "",
    logger: { subscribe: () => noop },
    bus: { on: noop },
    sessionManager: { list: () => [{ id: "s1", status: "online" }] },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  let first;
  let second;
  try {
    first = await connectForSessions(port);
    hub.pushSessions(); // 填充全局去重缓存，模拟已有客户端的稳定状态。
    second = await connectForSessions(port);
    assert.deepEqual(second.message.data, [{ id: "s1", status: "online" }]);
  } finally {
    first?.ws.close();
    second?.ws.close();
    hub.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
