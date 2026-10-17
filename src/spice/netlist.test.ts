import { describe, expect, it } from "vitest";
import { buildSchematicSnapshot } from "../schematic/analysis.js";
import type { LtspiceSymbol } from "./ltspiceSymbols.js";
import type { MappingFile } from "./models.js";
import { buildSpiceNetlist, type SymbolLookup } from "./netlist.js";

const symbols: SymbolLookup = {
  async find(name: string): Promise<LtspiceSymbol | undefined> {
    return name.toLowerCase() === "lt1013"
      ? { name: "LT1013", file: "LT1013.asy", prefix: "X", spiceModel: "LT1013.sub", ports: ["In+", "In-", "V+", "V-", "OUT"] }
      : undefined;
  }
};

const dualOpAmpRule: MappingFile["parts"][number] = {
  match: { lcsc: "C9999" },
  kind: "subckt",
  model: "LT1013",
  units: [
    { pinMap: { "3": "In+", "2": "In-", "8": "V+", "4": "V-", "1": "OUT" } },
    { pinMap: { "5": "In+", "6": "In-", "8": "V+", "4": "V-", "7": "OUT" } }
  ],
  verified: true
};

function part(primitiveId: string, designator: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { primitiveId, designator, componentType: "part", ...extra };
}

function pins(...entries: Array<[string, string | undefined]>): Array<Record<string, unknown>> {
  return entries.map(([pinNumber, net]) => ({ primitiveId: `pin-${pinNumber}-${net}`, pinNumber, net }));
}

function invertingAmplifier(overrides: { u1Extra?: Record<string, unknown> } = {}) {
  return buildSchematicSnapshot({
    components: [
      part("$u1a", "U1", { supplierId: "C9999", subPartName: "U1.1", ...overrides.u1Extra }),
      part("$u1b", "U1", { supplierId: "C9999", subPartName: "U1.2", ...overrides.u1Extra }),
      part("$r1", "R1", { otherProperty: { Value: "10kΩ" } }),
      part("$r2", "R2", { otherProperty: { Value: "4k7" } }),
      part("$r3", "R3", { otherProperty: { Value: "DNP" } }),
      part("$c1", "C1", { otherProperty: { Value: "100nF" } }),
      part("$j1", "J1", { otherProperty: { Value: "HDR-3" } }),
      { primitiveId: "$gnd", componentType: "netflag", net: "GND" }
    ],
    pinsByComponent: {
      $u1a: pins(["1", "VOUT"], ["2", "INV"], ["3", "GND"], ["4", "VEE"], ["8", "VCC"]),
      $u1b: pins(["5", "GND"], ["6", "BUF"], ["7", "BUF"]),
      $r1: pins(["1", "VIN"], ["2", "INV"]),
      $r2: pins(["1", "INV"], ["2", "VOUT"]),
      $r3: pins(["1", "VOUT"], ["2", "GND"]),
      $c1: pins(["1", "VCC"], ["2", "GND"]),
      $j1: pins(["1", "VIN"], ["2", "VCC"], ["3", "GND"])
    },
    wires: [{ primitiveId: "w1", net: "GND", line: [0, 0, 10, 0] }],
    includeRaw: true
  });
}

describe("buildSpiceNetlist", () => {
  it("emits passives, multi-unit op-amps, and ground", async () => {
    const result = await buildSpiceNetlist(invertingAmplifier(), { mapping: { version: 1, parts: [dualOpAmpRule] }, symbols });

    expect(result.ok).toBe(true);
    expect(result.netlist).toContain(".lib LT1013.sub");
    expect(result.netlist).toContain("C1 VCC 0 100n");
    expect(result.netlist).toContain("R1 VIN INV 10k");
    expect(result.netlist).toContain("R2 INV VOUT 4.7k");
    expect(result.netlist).toContain("XU1A 0 INV VCC VEE VOUT LT1013");
    expect(result.netlist).toContain("XU1B 0 BUF VCC VEE BUF LT1013");
    expect(result.netlist).not.toContain("R3");
    expect(result.nodes).toMatchObject({ GND: "0", VOUT: "VOUT" });

    const byDesignator = Object.fromEntries(result.components.map((item) => [item.designator, item]));
    expect(byDesignator.R3.status).toBe("skipped");
    expect(byDesignator.J1.status).toBe("ignored");
    expect(byDesignator.U1).toMatchObject({ status: "emitted", matchedBy: "mapping", matchKey: "lcsc=C9999" });
  });

  it("reports unknown parts instead of guessing", async () => {
    const result = await buildSpiceNetlist(invertingAmplifier(), { mapping: { version: 1, parts: [] }, symbols });

    expect(result.ok).toBe(false);
    expect(result.unresolved.map((item) => item.designator)).toEqual(["U1"]);
    expect(result.unresolved[0].reason).toContain("LCSC C9999");
  });

  it("rejects pin maps that leave a connected pin unmapped", async () => {
    const rule = { ...dualOpAmpRule, units: [dualOpAmpRule.units![0]] };
    const result = await buildSpiceNetlist(invertingAmplifier(), { mapping: { version: 1, parts: [rule] }, symbols });

    expect(result.ok).toBe(false);
    expect(result.unresolved[0].reason).toContain("pins 5, 6, 7 are connected but not in pinMap");
  });

  it("rejects ports that are missing or mapped twice", async () => {
    const rule = { ...dualOpAmpRule, units: [{ pinMap: { "3": "In+", "2": "In+", "8": "V+", "4": "V-", "1": "OUT" } }, dualOpAmpRule.units![1]] };
    const result = await buildSpiceNetlist(invertingAmplifier(), { mapping: { version: 1, parts: [rule] }, symbols });

    expect(result.unresolved[0].reason).toContain('port "In+" is mapped twice');
  });

  it("lets SPICE_* attributes override models.json", async () => {
    const snapshot = invertingAmplifier({
      u1Extra: {
        otherProperty: {
          SPICE_Kind: "subckt",
          SPICE_Model: "MYAMP",
          SPICE_Include: "models/myamp.lib",
          SPICE_Ports: "In+,In-,V+,V-,OUT",
          SPICE_PinMap: "3=In+,2=In-,8=V+,4=V-,1=OUT;5=In+,6=In-,8=V+,4=V-,7=OUT"
        }
      }
    });
    const result = await buildSpiceNetlist(snapshot, {
      mapping: { version: 1, parts: [dualOpAmpRule] },
      symbols,
      resolveInclude: (include) => `/sim/${include}`
    });

    expect(result.ok).toBe(true);
    expect(result.netlist).toContain(".lib /sim/models/myamp.lib");
    expect(result.netlist).toContain("XU1A 0 INV VCC VEE VOUT MYAMP");
    expect(result.unverified).toEqual(["U1"]);
  });

  it("changes the snapshot hash when a value changes", async () => {
    const first = await buildSpiceNetlist(invertingAmplifier(), { mapping: { version: 1, parts: [dualOpAmpRule] }, symbols });
    const snapshot = invertingAmplifier();
    snapshot.components.find((item) => item.designator === "R2")!.value = "10k";
    const second = await buildSpiceNetlist(snapshot, { mapping: { version: 1, parts: [dualOpAmpRule] }, symbols });

    expect(second.snapshotHash).not.toBe(first.snapshotHash);
    expect(second.netlist).toContain("R2 INV VOUT 10k");
  });
});
