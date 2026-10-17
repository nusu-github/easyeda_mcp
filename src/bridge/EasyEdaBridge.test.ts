import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EasyEdaBridge } from "./EasyEdaBridge.js";
import { BridgeControlError, BridgeProtocolCompatibilityError, BridgeRpcError, BridgeUnavailableError } from "./errors.js";

const bridges: EasyEdaBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

describe("EasyEdaBridge", () => {
  it("reports disconnected status before an extension connects", async () => {
    const bridge = await startBridge();

    expect(bridge.getStatus().connected).toBe(false);
    await expect(bridge.call("getContext")).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  it("round-trips RPC calls through a WebSocket extension client", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      client.send(JSON.stringify({
        kind: "result",
        requestId: message.requestId,
        result: {
          method: message.method,
          params: message.params
        }
      }));
    });

    const result = await bridge.call("findComponent", { query: "U1" });

    expect(result).toEqual({
      method: "findComponent",
      params: { query: "U1" }
    });
    client.close();
  });

  it("updates status from hello messages", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.send(JSON.stringify({
      kind: "hello",
      client: "easyeda-pro-extension",
      version: "0.1.0",
      protocolVersion: "0.1.0",
      capabilities: {
        websocket: true,
        pcbDocument: true
      },
      status: {
        documentName: "main pcb"
      }
    }));

    await wait(20);

    expect(bridge.getStatus()).toMatchObject({
      connected: true,
      extensionVersion: "0.1.0",
      documentName: "main pcb"
    });
    client.close();
  });

  it("blocks calls when the extension protocol is incompatible", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.send(JSON.stringify({
      kind: "hello",
      client: "easyeda-pro-extension",
      version: "0.1.0",
      protocolVersion: "9.9.9",
      capabilities: {
        websocket: true
      }
    }));

    await wait(20);

    await expect(bridge.call("getContext")).rejects.toBeInstanceOf(BridgeProtocolCompatibilityError);
    client.close();
  });

  it("turns remote errors into BridgeRpcError", async () => {
    const bridge = await startBridge();
    const client = await connectClient(bridge.endpoint);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      client.send(JSON.stringify({
        kind: "error",
        requestId: message.requestId,
        error: {
          code: "api_unavailable",
          message: "missing EasyEDA API"
        }
      }));
    });

    await expect(bridge.call("zoomBoard")).rejects.toBeInstanceOf(BridgeRpcError);
    client.close();
  });

  it("allows a newer extension connection to replace the old one", async () => {
    const bridge = await startBridge();
    const oldClient = await connectClient(bridge.endpoint);
    const newClient = await connectClient(bridge.endpoint);
    newClient.on("message", (data) => {
      const message = JSON.parse(data.toString());
      newClient.send(JSON.stringify({
        kind: "result",
        requestId: message.requestId,
        result: "new-client"
      }));
    });

    await wait(20);

    await expect(bridge.call("getContext")).resolves.toBe("new-client");
    oldClient.close();
    newClient.close();
  });

  it("rejects pending calls when a newer extension connection replaces the old one", async () => {
    const bridge = await startBridge();
    const oldClient = await connectClient(bridge.endpoint);
    const pendingCall = bridge.call("getContext");
    pendingCall.catch(() => undefined);

    await wait(20);
    const newClient = await connectClient(bridge.endpoint);
    newClient.on("message", (data) => {
      const message = JSON.parse(data.toString());
      newClient.send(JSON.stringify({
        kind: "result",
        requestId: message.requestId,
        result: "new-client"
      }));
    });

    await expect(pendingCall).rejects.toBeInstanceOf(BridgeUnavailableError);
    oldClient.close();
    newClient.close();
  });
});

describe("EasyEdaBridge shared sessions", () => {
  it("relays peer calls to the extension through the hub", async () => {
    const hub = await startBridge();
    const extension = await connectExtension(hub.endpoint);
    const peer = await startPeer(hub);

    expect(peer.getStatus().session?.role).toBe("peer");
    await waitFor(async () => peer.getStatus().connected === true);
    await expect(peer.call("schematicSnapshot", { allPages: true })).resolves.toEqual({ method: "schematicSnapshot", params: { allPages: true } });
    expect(hub.getStatus().session?.peers).toBe(1);
    extension.close();
  });

  it("lets anyone read but requires the control right to operate, and allows taking it", async () => {
    const hub = await startBridge("Chat");
    const extension = await connectExtension(hub.endpoint);
    const peer = await startPeer(hub, "Code");

    await expect(hub.call("setComponentValues", {})).resolves.toMatchObject({ method: "setComponentValues" });
    expect(hub.getStatus().session?.control).toMatchObject({ holderLabel: "Chat", heldByThisSession: true });

    await expect(peer.call("getContext")).resolves.toMatchObject({ method: "getContext" });
    const denied = peer.call("setComponentValues", {});
    await expect(denied).rejects.toBeInstanceOf(BridgeControlError);
    await expect(denied).rejects.toThrow(/Chat holds/);

    await expect(peer.controlAction("take")).resolves.toMatchObject({ holderLabel: "Code" });
    await expect(peer.call("setComponentValues", {})).resolves.toMatchObject({ method: "setComponentValues" });
    await expect(hub.call("confirmedAction", {})).rejects.toBeInstanceOf(BridgeControlError);
    await waitFor(async () => peer.getStatus().session?.control.heldByThisSession === true);

    await peer.controlAction("release");
    await expect(hub.call("confirmedAction", {})).resolves.toMatchObject({ method: "confirmedAction" });
    extension.close();
  });

  it("frees the control right when the holding peer disconnects", async () => {
    const hub = await startBridge("Chat");
    const extension = await connectExtension(hub.endpoint);
    const peer = await startPeer(hub, "Code");
    await peer.controlAction("take");

    await peer.stop();
    await waitFor(async () => !hub.getStatus().session?.control.holderId);
    await expect(hub.call("zoomBoard")).resolves.toMatchObject({ method: "zoomBoard" });
    extension.close();
  });

  it("promotes a peer to hub when the hub exits", async () => {
    const hub = await startBridge();
    const port = Number(new URL(hub.endpoint).port);
    const peer = await startPeer(hub);

    await hub.stop();
    bridges.splice(bridges.indexOf(hub), 1);
    await waitFor(async () => peer.getStatus().session?.role === "hub");

    const extension = await connectExtension(`ws://127.0.0.1:${port}`);
    await expect(peer.call("getContext")).resolves.toMatchObject({ method: "getContext" });
    extension.close();
  });
});

const silentLogger = { error: () => undefined, warn: () => undefined, info: () => undefined };

async function startPeer(hub: EasyEdaBridge, label?: string): Promise<EasyEdaBridge> {
  const peer = new EasyEdaBridge({ port: Number(new URL(hub.endpoint).port), roleRetryMs: 50, logger: silentLogger, label });
  bridges.push(peer);
  await peer.start();
  return peer;
}

/** A fake extension that says hello and echoes every call back. */
async function connectExtension(endpoint: string): Promise<WebSocket> {
  const client = await connectClient(endpoint);
  client.on("message", (data) => {
    const message = JSON.parse(data.toString());
    client.send(JSON.stringify({ kind: "result", requestId: message.requestId, result: { method: message.method, params: message.params } }));
  });
  client.send(JSON.stringify({ kind: "hello", client: "easyeda-pro-extension", version: "0.1.0", protocolVersion: "0.1.0", capabilities: {} }));
  await wait(20);
  return client;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}

async function startBridge(label?: string): Promise<EasyEdaBridge> {
  const bridge = new EasyEdaBridge({
    label,
    port: 0,
    logger: {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined
    }
  });
  await bridge.start();
  bridges.push(bridge);
  return bridge;
}

async function connectClient(endpoint: string): Promise<WebSocket> {
  const client = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return client;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
