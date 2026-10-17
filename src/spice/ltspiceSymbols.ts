import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type LtspiceSymbol = {
  name: string;
  file: string;
  prefix?: string;
  spiceModel?: string;
  value?: string;
  /** Port names in SPICE node order (from PINATTR SpiceOrder). */
  ports: string[];
};

export function defaultLtspiceLibDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LTSPICE_LIB_DIR) {
    return env.LTSPICE_LIB_DIR;
  }
  const localAppData = env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
  return path.join(localAppData, "LTspice", "lib");
}

/** Decodes LTspice text files, which may be UTF-16LE (with or without BOM) or 8-bit. */
export function decodeLtspiceText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[1] === 0x00 && buffer[0] !== 0x00) {
    return buffer.toString("utf16le");
  }
  return buffer.toString("latin1");
}

export function parseAsy(text: string, file = "", name = path.basename(file, path.extname(file))): LtspiceSymbol {
  const symbol: LtspiceSymbol = { name, file, ports: [] };
  const pins: Array<{ name?: string; order?: number }> = [];
  let current: { name?: string; order?: number } | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^PIN\s/i.test(line)) {
      current = {};
      pins.push(current);
      continue;
    }
    const pinAttr = /^PINATTR\s+(\S+)\s+(.*)$/i.exec(line);
    if (pinAttr && current) {
      if (pinAttr[1].toLowerCase() === "pinname") current.name = pinAttr[2].trim();
      if (pinAttr[1].toLowerCase() === "spiceorder") current.order = Number(pinAttr[2]);
      continue;
    }
    const symAttr = /^SYMATTR\s+(\S+)\s+(.*)$/i.exec(line);
    if (symAttr) {
      const key = symAttr[1].toLowerCase();
      if (key === "prefix") symbol.prefix = symAttr[2].trim();
      if (key === "spicemodel") symbol.spiceModel = symAttr[2].trim();
      if (key === "value") symbol.value = symAttr[2].trim();
    }
  }

  symbol.ports = pins
    .filter((pin): pin is { name: string; order: number } => Boolean(pin.name) && Number.isFinite(pin.order))
    .sort((left, right) => left.order - right.order)
    .map((pin) => pin.name);
  return symbol;
}

export class LtspiceSymbolIndex {
  private index?: Map<string, string>;

  constructor(readonly libDir: string = defaultLtspiceLibDir()) {}

  /** Finds a symbol by explicit relative path ("OpAmps/LT1013") or by file name anywhere under lib/sym. */
  async find(nameOrPath: string): Promise<LtspiceSymbol | undefined> {
    const symDir = path.join(this.libDir, "sym");
    const relative = nameOrPath.replace(/\.asy$/i, "");
    if (/[\\/]/.test(relative)) {
      return this.load(path.join(symDir, `${relative}.asy`));
    }
    const index = await this.buildIndex(symDir);
    const file = index.get(relative.toLowerCase());
    return file ? this.load(file) : undefined;
  }

  private async load(file: string): Promise<LtspiceSymbol | undefined> {
    try {
      return parseAsy(decodeLtspiceText(await readFile(file)), file);
    } catch {
      return undefined;
    }
  }

  private async buildIndex(symDir: string): Promise<Map<string, string>> {
    if (this.index) {
      return this.index;
    }
    const index = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.toLowerCase().endsWith(".asy")) {
          const key = entry.name.slice(0, -4).toLowerCase();
          if (!index.has(key)) index.set(key, full);
        }
      }
    };
    await walk(symDir);
    this.index = index;
    return index;
  }
}
