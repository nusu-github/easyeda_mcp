export type ValueKind = "resistor" | "capacitor" | "inductor";

export type ParsedValue = {
  value: number;
  spice: string;
};

const SPICE_SUFFIXES: Array<[number, string]> = [
  [1e12, "T"],
  [1e9, "G"],
  [1e6, "Meg"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "u"],
  [1e-9, "n"],
  [1e-12, "p"],
  [1e-15, "f"]
];

const EASYEDA_SUFFIXES: Array<[number, string]> = SPICE_SUFFIXES.map(([scale, suffix]) => [scale, suffix === "Meg" ? "M" : suffix]);

const UNIT_SYMBOLS: Record<ValueKind, string> = {
  resistor: "Ω",
  capacitor: "F",
  inductor: "H"
};

const SPICE_SCALE: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15
};

const NOT_POPULATED = /^(dnp|dnf|nc|n\/c|nf|nm|open)$/i;

export function isNotPopulated(text: string | undefined): boolean {
  return Boolean(text && NOT_POPULATED.test(text.trim()));
}

/**
 * Parses an EasyEDA component value ("10kΩ", "4k7", "100nF 50V", "1MΩ ±1%") into a number.
 * Uppercase M means mega here because EasyEDA libraries use it that way; lowercase m is milli.
 */
export function parseComponentValue(text: string | undefined): ParsedValue | undefined {
  if (!text) {
    return undefined;
  }
  for (const token of text.trim().split(/[\s,;/]+/)) {
    const value = parseToken(token);
    if (value !== undefined) {
      return { value, spice: formatSpiceNumber(value) };
    }
  }
  return undefined;
}

function parseToken(raw: string): number | undefined {
  const token = raw
    .replace(/[µμ]/g, "u")
    .replace(/Ω|ohms?|Ohms?/g, "")
    .trim();
  if (!token || /%$/.test(token) || /^±/.test(token)) {
    return undefined;
  }

  // RKM notation: 4k7, 2R2, 4n7, 1M5
  const rkm = /^(\d+)(R|r|k|K|M|m|u|n|p|G)(\d+)(F|H)?$/.exec(token);
  if (rkm) {
    const scale = rkm[2] === "R" || rkm[2] === "r" ? 1 : prefixScale(rkm[2]);
    return scale === undefined ? undefined : Number(`${rkm[1]}.${rkm[3]}`) * scale;
  }

  const match = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(Meg|MEG|meg|[TGMkKmunpf])?(F|H|V|A|W|R)?$/.exec(token);
  if (!match) {
    return undefined;
  }
  if (match[3] && ["V", "A", "W"].includes(match[3])) {
    return undefined;
  }
  const scale = match[2] ? prefixScale(match[2]) : 1;
  if (scale === undefined) {
    return undefined;
  }
  return Number(match[1]) * scale;
}

function prefixScale(prefix: string): number | undefined {
  switch (prefix) {
    case "T": return 1e12;
    case "G": return 1e9;
    case "M":
    case "Meg":
    case "MEG":
    case "meg": return 1e6;
    case "k":
    case "K": return 1e3;
    case "m": return 1e-3;
    case "u": return 1e-6;
    case "n": return 1e-9;
    case "p": return 1e-12;
    case "f": return 1e-15;
    default: return undefined;
  }
}

/** Parses a SPICE number ("4.7k", "1Meg", "100n", "2.2e-6"). Here M is milli, as in SPICE. */
export function parseSpiceNumber(text: string): number | undefined {
  const match = /^\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(meg|[tgkmunpf])?[a-z]*\s*$/i.exec(text);
  if (!match) {
    return undefined;
  }
  const suffix = match[2]?.toLowerCase();
  const scale = suffix === undefined ? 1 : SPICE_SCALE[suffix];
  return scale === undefined ? undefined : Number(match[1]) * scale;
}

export function formatSpiceNumber(value: number): string {
  return formatWithSuffixes(value, SPICE_SUFFIXES);
}

/** Formats a value the way EasyEDA/LCSC libraries write it: "4.7kΩ", "100nF", "1MΩ", "10uH". */
export function formatEasyEdaValue(value: number, kind: ValueKind): string {
  return `${formatWithSuffixes(value, EASYEDA_SUFFIXES)}${UNIT_SYMBOLS[kind]}`;
}

function formatWithSuffixes(value: number, suffixes: Array<[number, string]>): string {
  if (value === 0) {
    return "0";
  }
  const magnitude = Math.abs(value);
  const [scale, suffix] = suffixes.find(([candidate]) => magnitude >= candidate * 0.9999995) ?? suffixes[suffixes.length - 1];
  const mantissa = Number((value / scale).toPrecision(6));
  return `${mantissa}${suffix}`;
}

export function valueKindForDesignator(designator: string | undefined): ValueKind | undefined {
  const prefix = designatorPrefix(designator);
  if (prefix === "R") return "resistor";
  if (prefix === "C") return "capacitor";
  if (prefix === "L") return "inductor";
  return undefined;
}

export function designatorPrefix(designator: string | undefined): string {
  return (/^[A-Za-z]+/.exec(designator ?? "")?.[0] ?? "").toUpperCase();
}

export function sameComponentValue(left: string | undefined, right: string | undefined): boolean {
  if ((left ?? "").trim() === (right ?? "").trim()) {
    return true;
  }
  const a = parseComponentValue(left);
  const b = parseComponentValue(right);
  if (!a || !b) {
    return false;
  }
  return Math.abs(a.value - b.value) <= Math.max(Math.abs(a.value), Math.abs(b.value)) * 1e-9;
}
