import { readFile } from "node:fs/promises";
import * as z from "zod/v4";
import { designatorPrefix } from "./values.js";

const PinMapSchema = z.record(z.string(), z.string().min(1));

export const PartRuleSchema = z.object({
  match: z.object({
    lcsc: z.string().min(1).optional(),
    mpn: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    designator: z.string().min(1).optional()
  }).refine((match) => Object.keys(match).length > 0, "match needs at least one key"),
  kind: z.enum(["primitive", "model", "subckt", "ignore", "short"]),
  prefix: z.enum(["R", "C", "L", "D", "Q", "M", "J"]).optional(),
  model: z.string().min(1).optional(),
  include: z.string().min(1).optional(),
  symbol: z.string().min(1).optional().describe("LTspice symbol (e.g. \"OpAmps/LT1013\") whose SpiceOrder defines the port order."),
  ports: z.array(z.string().min(1)).optional().describe("Explicit port order; overrides the symbol."),
  pinMap: PinMapSchema.optional(),
  units: z.array(z.object({ pinMap: PinMapSchema })).optional(),
  ignorePins: z.array(z.string()).optional(),
  params: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  verified: z.boolean().default(false)
});

export const MappingFileSchema = z.object({
  version: z.literal(1),
  groundNets: z.array(z.string().min(1)).optional(),
  parts: z.array(PartRuleSchema).default([])
});

export type PartRule = z.infer<typeof PartRuleSchema>;
export type MappingFile = z.infer<typeof MappingFileSchema>;

export const DEFAULT_GROUND_NETS = ["GND", "AGND", "DGND", "PGND", "GNDA", "GNDD", "0"];
const IGNORED_PREFIXES = new Set(["H", "MH", "FID", "TP", "LOGO", "MK"]);
const CONNECTOR_PREFIXES = new Set(["J", "P", "CN", "CON", "USB"]);

export type PartIdentity = {
  designator: string;
  lcsc?: string;
  mpn?: string;
  name?: string;
  attributes: Record<string, string>;
};

export type Resolution =
  | { status: "resolved"; rule: PartRule; matchedBy: "attributes" | "mapping" | "default"; matchKey?: string }
  | { status: "ignored"; matchedBy: "mapping" | "attributes" | "default"; reason: string }
  | { status: "unresolved"; reason: string };

export async function loadMappingFile(file: string): Promise<{ mapping: MappingFile; found: boolean }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { mapping: { version: 1, parts: [] }, found: false };
    }
    throw error;
  }
  const parsed = MappingFileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`Invalid model mapping file ${file}: ${z.prettifyError(parsed.error)}`);
  }
  return { mapping: parsed.data, found: true };
}

export function resolvePart(part: PartIdentity, mapping: MappingFile): Resolution {
  const fromAttributes = ruleFromAttributes(part.attributes);
  if (fromAttributes) {
    return fromAttributes.kind === "ignore"
      ? { status: "ignored", matchedBy: "attributes", reason: "SPICE_Kind=ignore on the component." }
      : { status: "resolved", rule: fromAttributes, matchedBy: "attributes" };
  }

  for (const [key, value] of [["lcsc", part.lcsc], ["mpn", part.mpn], ["name", part.name], ["designator", part.designator]] as const) {
    if (!value) continue;
    const rule = mapping.parts.find((candidate) => sameKey(candidate.match[key], value));
    if (rule) {
      return rule.kind === "ignore"
        ? { status: "ignored", matchedBy: "mapping", reason: `models.json marks ${key}=${value} as ignore.` }
        : { status: "resolved", rule, matchedBy: "mapping", matchKey: `${key}=${value}` };
    }
  }

  const prefix = designatorPrefix(part.designator);
  if (prefix === "R" || prefix === "C" || prefix === "L") {
    return { status: "resolved", rule: { match: { designator: part.designator }, kind: "primitive", prefix, verified: true }, matchedBy: "default" };
  }
  if (IGNORED_PREFIXES.has(prefix)) {
    return { status: "ignored", matchedBy: "default", reason: `Designator prefix ${prefix} is mechanical (hole, fiducial, test point).` };
  }
  if (CONNECTOR_PREFIXES.has(prefix)) {
    return { status: "ignored", matchedBy: "default", reason: `Connector ${part.designator} is dropped; its nets keep their names for the test bench.` };
  }
  return { status: "unresolved", reason: `No SPICE_* attributes and no models.json entry for ${describe(part)}.` };
}

function ruleFromAttributes(attributes: Record<string, string>): PartRule | undefined {
  const kind = attributes.SPICE_Kind?.trim().toLowerCase();
  if (!kind) {
    return undefined;
  }
  const parsed = PartRuleSchema.safeParse({
    match: { designator: "attributes" },
    kind,
    prefix: attributes.SPICE_Prefix?.trim().toUpperCase() || undefined,
    model: attributes.SPICE_Model?.trim() || undefined,
    include: attributes.SPICE_Include?.trim() || undefined,
    symbol: attributes.SPICE_Symbol?.trim() || undefined,
    ports: attributes.SPICE_Ports ? splitList(attributes.SPICE_Ports) : undefined,
    units: attributes.SPICE_PinMap ? attributes.SPICE_PinMap.split(";").map((unit) => ({ pinMap: parsePinMap(unit) })) : undefined,
    params: attributes.SPICE_Params?.trim() || undefined,
    source: "component attributes",
    verified: attributes.SPICE_Verified?.trim().toLowerCase() === "true"
  });
  if (!parsed.success) {
    throw new Error(`Invalid SPICE_* attributes: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Parses "3=In+,2=In-,1=OUT" into { "3": "In+", ... }. */
export function parsePinMap(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of splitList(text)) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      throw new Error(`Invalid SPICE_PinMap entry "${entry}"; expected pin=port.`);
    }
    output[entry.slice(0, index).trim()] = entry.slice(index + 1).trim();
  }
  return output;
}

/** Units of a rule: explicit `units`, or one unit from `pinMap`. */
export function ruleUnits(rule: PartRule): Array<Record<string, string>> {
  if (rule.units && rule.units.length > 0) return rule.units.map((unit) => unit.pinMap);
  if (rule.pinMap) return [rule.pinMap];
  return [];
}

function splitList(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function sameKey(left: string | undefined, right: string): boolean {
  return left !== undefined && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function describe(part: PartIdentity): string {
  return [part.designator, part.lcsc && `LCSC ${part.lcsc}`, part.mpn && `MPN ${part.mpn}`, part.name].filter(Boolean).join(", ");
}
