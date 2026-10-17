import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildSchematicSnapshot } from "../schematic/analysis.js";
import { registerSpiceTools } from "./registerSpiceTools.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function setup(call: ReturnType<typeof vi.fn>, env: NodeJS.ProcessEnv = {}, names: { projectName?: string; documentName?: string } = { projectName: "Amp", documentName: "Main" }) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const bridge = {
    endpoint: "ws://127.0.0.1:8765",
    getStatus: () => ({ connected: true, ...names, updatedAt: new Date().toISOString() }),
    call
  };
  registerSpiceTools(server, bridge as never, {
    env,
    symbols: { find: async () => undefined },
    now: () => new Date(2026, 9, 17, 12, 0, 0)
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function rcSnapshot() {
  return buildSchematicSnapshot({
    components: [
      { primitiveId: "$r1", designator: "R1", componentType: "part", otherProperty: { Value: "10kΩ" } },
      { primitiveId: "$c1", designator: "C1", componentType: "part", otherProperty: { Value: "100nF" } }
    ],
    pinsByComponent: {
      $r1: [{ pinNumber: "1", net: "VIN" }, { pinNumber: "2", net: "VOUT" }],
      $c1: [{ pinNumber: "1", net: "VOUT" }, { pinNumber: "2", net: "GND" }]
    },
    wires: [],
    includeRaw: true
  });
}

describe("easyeda_export_spice", () => {
  it("writes a run with the DUT and the bench under EASYEDA_SIM_DIR", async () => {
    const simDir = await mkdtemp(path.join(tmpdir(), "easyeda-sim-"));
    await mkdir(path.join(simDir, "benches"));
    await writeFile(path.join(simDir, "benches", "rc.bench.cir"), "V1 VIN 0 AC 1\n.ac dec 20 10 1Meg\n.end\n");
    const call = vi.fn(async () => rcSnapshot());
    const client = await setup(call, { EASYEDA_SIM_DIR: simDir });

    const result = await client.callTool({ name: "easyeda_export_spice", arguments: { bench: "rc" } });

    expect(result.isError).toBeFalsy();
    expect(call).toHaveBeenCalledWith("schematicSnapshot", { includeRaw: true, allPages: true }, 30_000);
    const content = result.structuredContent as { ok: boolean; files: { circuitPath: string } };
    expect(content.ok).toBe(true);
    expect(content.files.circuitPath).toBe(path.join(simDir, "runs", "20261017-120000", "circuit.cir"));
    const circuit = await readFile(content.files.circuitPath, "utf8");
    expect(circuit).toContain("R1 VIN VOUT 10k");
    expect(circuit).toContain("C1 VOUT 0 100n");
    expect(circuit).toContain(".ac dec 20 10 1Meg");
    expect(circuit.match(/^\.end$/gm)).toHaveLength(1);
  });

  it("takes the project name from the page frame when the status has none", async () => {
    const snapshot = rcSnapshot();
    snapshot.components.push({ primitiveId: "$sheet", componentType: "sheet", attributes: { "@Project Name": "Filter Board", "@Schematic Name": "Main" }, position: {} });
    const client = await setup(vi.fn(async () => snapshot), {}, {});

    const result = await client.callTool({ name: "easyeda_export_spice", arguments: { write: false } });

    const content = result.structuredContent as { simDir: string; netlist: string };
    expect(content.simDir).toBe(path.join(homedir(), "Documents", "easyeda-sim", "Filter Board"));
    expect(content.netlist).toContain("* Filter Board / Main");
  });

  it("writes nothing when parts are unresolved", async () => {
    const simDir = await mkdtemp(path.join(tmpdir(), "easyeda-sim-"));
    const snapshot = rcSnapshot();
    snapshot.components.push({ primitiveId: "$u1", designator: "U1", componentType: "part", position: {} });
    snapshot.pins.push({ componentPrimitiveId: "$u1", componentDesignator: "U1", pinNumber: "1", net: "VOUT", position: {} });
    const client = await setup(vi.fn(async () => snapshot), { EASYEDA_SIM_DIR: simDir });

    const result = await client.callTool({ name: "easyeda_export_spice", arguments: {} });

    const content = result.structuredContent as { ok: boolean; files?: unknown; unresolved: Array<{ designator: string }> };
    expect(content.ok).toBe(false);
    expect(content.files).toBeUndefined();
    expect(content.unresolved.map((item) => item.designator)).toEqual(["U1"]);
  });
});

describe("easyeda_set_component_values", () => {
  it("blocks writes without confirmation", async () => {
    const call = vi.fn();
    const client = await setup(call);

    const result = await client.callTool({
      name: "easyeda_set_component_values",
      arguments: { changes: [{ designator: "R1", value: "4.7k", expected: "10kΩ" }] }
    });

    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("allows dry runs without confirmation and normalizes values", async () => {
    const call = vi.fn(async () => ({ results: [{ status: "planned" }] }));
    const client = await setup(call);

    const result = await client.callTool({
      name: "easyeda_set_component_values",
      arguments: { dryRun: true, runId: "run-1", changes: [{ designator: "R1", value: "1Meg", expected: "10kΩ" }] }
    });

    expect(result.isError).toBeFalsy();
    expect(call).toHaveBeenCalledWith("setComponentValues", {
      dryRun: true,
      changes: [{
        designator: "R1",
        key: "Value",
        value: "1MΩ",
        expected: "10kΩ",
        extra: { SIM_LastRun: "run-1" },
        extraIfSupplier: { SIM_PartStale: "true" }
      }]
    }, 30_000);
  });

  it("rejects unparseable values before calling the bridge", async () => {
    const call = vi.fn();
    const client = await setup(call);

    const result = await client.callTool({
      name: "easyeda_set_component_values",
      arguments: { confirmation: "承認", changes: [{ designator: "C3", value: "big" }] }
    });

    expect(result.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});
