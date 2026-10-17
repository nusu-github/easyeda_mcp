import { describe, expect, it } from "vitest";
import {
  formatEasyEdaValue,
  formatSpiceNumber,
  isNotPopulated,
  parseComponentValue,
  parseSpiceNumber,
  sameComponentValue
} from "./values.js";

describe("parseComponentValue", () => {
  it.each([
    ["10kΩ", "10k"],
    ["10K", "10k"],
    ["4k7", "4.7k"],
    ["2R2", "2.2"],
    ["1MΩ", "1Meg"],
    ["1M5", "1.5Meg"],
    ["100nF", "100n"],
    ["0.1uF", "100n"],
    ["100µF", "100u"],
    ["4.7uH ±20%", "4.7u"],
    ["100nF 50V X7R", "100n"],
    ["22pF", "22p"],
    ["0Ω", "0"],
    ["10mH", "10m"]
  ])("parses %s as %s", (text, spice) => {
    expect(parseComponentValue(text)?.spice).toBe(spice);
  });

  it("rejects non-numeric values", () => {
    expect(parseComponentValue("LM358")).toBeUndefined();
    expect(parseComponentValue("50V")).toBeUndefined();
    expect(parseComponentValue(undefined)).toBeUndefined();
  });
});

describe("SPICE numbers", () => {
  it("treats M as milli and Meg as mega", () => {
    expect(parseSpiceNumber("1M")).toBeCloseTo(1e-3);
    expect(parseSpiceNumber("1Meg")).toBeCloseTo(1e6);
    expect(parseSpiceNumber("4.7k")).toBeCloseTo(4700);
    expect(parseSpiceNumber("2.2e-6")).toBeCloseTo(2.2e-6);
  });

  it("formats with engineering suffixes", () => {
    expect(formatSpiceNumber(4700)).toBe("4.7k");
    expect(formatSpiceNumber(1e6)).toBe("1Meg");
    expect(formatSpiceNumber(1e-7)).toBe("100n");
    expect(formatSpiceNumber(12.5)).toBe("12.5");
  });
});

describe("formatEasyEdaValue", () => {
  it("uses EasyEDA library conventions", () => {
    expect(formatEasyEdaValue(4700, "resistor")).toBe("4.7kΩ");
    expect(formatEasyEdaValue(1e6, "resistor")).toBe("1MΩ");
    expect(formatEasyEdaValue(1e-7, "capacitor")).toBe("100nF");
    expect(formatEasyEdaValue(1e-5, "inductor")).toBe("10uH");
  });
});

describe("value comparison", () => {
  it("compares by number, not spelling", () => {
    expect(sameComponentValue("4k7", "4.7kΩ")).toBe(true);
    expect(sameComponentValue("100nF", "0.1uF")).toBe(true);
    expect(sameComponentValue("10k", "1k")).toBe(false);
  });

  it("recognizes not-populated markers", () => {
    expect(isNotPopulated("DNP")).toBe(true);
    expect(isNotPopulated("10k")).toBe(false);
  });
});
