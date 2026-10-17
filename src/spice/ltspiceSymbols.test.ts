import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LtspiceSymbolIndex, decodeLtspiceText, parseAsy } from "./ltspiceSymbols.js";

const OPAMP_ASY = [
  "Version 4",
  "SymbolType CELL",
  "SYMATTR Value LT1013",
  "SYMATTR Prefix X",
  "SYMATTR SpiceModel LT1013.sub",
  "PIN -32 80 NONE 0",
  "PINATTR PinName In+",
  "PINATTR SpiceOrder 1",
  "PIN 0 -32 NONE 0",
  "PINATTR PinName V+",
  "PINATTR SpiceOrder 3",
  "PIN -32 48 NONE 0",
  "PINATTR PinName In-",
  "PINATTR SpiceOrder 2",
  "PIN 32 64 NONE 0",
  "PINATTR PinName OUT",
  "PINATTR SpiceOrder 5",
  "PIN 0 96 NONE 0",
  "PINATTR PinName V-",
  "PINATTR SpiceOrder 4"
].join("\r\n");

describe("parseAsy", () => {
  it("orders ports by SpiceOrder", () => {
    const symbol = parseAsy(OPAMP_ASY, "OpAmps/LT1013.asy");
    expect(symbol).toMatchObject({
      name: "LT1013",
      prefix: "X",
      spiceModel: "LT1013.sub",
      ports: ["In+", "In-", "V+", "V-", "OUT"]
    });
  });
});

describe("decodeLtspiceText", () => {
  it("decodes UTF-16LE without BOM", () => {
    expect(decodeLtspiceText(Buffer.from("* Copyright", "utf16le"))).toBe("* Copyright");
  });

  it("decodes UTF-16LE with BOM and plain text", () => {
    expect(decodeLtspiceText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("PIN", "utf16le")]))).toBe("PIN");
    expect(decodeLtspiceText(Buffer.from("PIN", "latin1"))).toBe("PIN");
  });
});

describe("LtspiceSymbolIndex", () => {
  it("finds symbols by name or relative path", async () => {
    const libDir = await mkdtemp(path.join(tmpdir(), "ltspice-lib-"));
    await mkdir(path.join(libDir, "sym", "OpAmps"), { recursive: true });
    await writeFile(path.join(libDir, "sym", "OpAmps", "LT1013.asy"), Buffer.from(OPAMP_ASY, "utf16le"));
    const index = new LtspiceSymbolIndex(libDir);

    expect((await index.find("lt1013"))?.ports).toEqual(["In+", "In-", "V+", "V-", "OUT"]);
    expect((await index.find("OpAmps/LT1013"))?.prefix).toBe("X");
    expect(await index.find("missing")).toBeUndefined();
  });
});
