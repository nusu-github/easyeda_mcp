import path from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EasyEdaBridge } from "../bridge/EasyEdaBridge.js";
import type { SchematicSnapshot } from "../schematic/analysis.js";
import { LtspiceSymbolIndex, defaultLtspiceLibDir } from "../spice/ltspiceSymbols.js";
import { loadMappingFile } from "../spice/models.js";
import { buildSpiceNetlist, type SymbolLookup } from "../spice/netlist.js";
import { MAPPING_FILE_NAME, makeIncludeResolver, newRunId, resolveSimDir, writeRun } from "../spice/simDir.js";
import { formatEasyEdaValue, parseComponentValue, valueKindForDesignator } from "../spice/values.js";
import { fail, ok } from "./toolResult.js";

export type SpiceToolDeps = {
  env?: NodeJS.ProcessEnv;
  symbols?: SymbolLookup;
  now?: () => Date;
};

const ValueChangeSchema = z.object({
  designator: z.string().min(1),
  value: z.string().min(1).describe("New value. EasyEDA style (\"4.7kΩ\", \"1MΩ\") or SPICE style (\"4.7k\", \"1Meg\"). For R/C/L it is normalized to EasyEDA style."),
  expected: z.string().min(1).optional().describe("Value the proposal was based on. The change is rejected if the live value differs."),
  key: z.string().min(1).default("Value").describe("Component property to change.")
});

const confirmationRegex = /\bconfirma\b|\bconfirmo\b|\bconfirmed\b|\bi confirm\b|承認/i;

export function registerSpiceTools(server: McpServer, bridge: EasyEdaBridge, deps: SpiceToolDeps = {}): void {
  const env = deps.env ?? process.env;
  const symbols = deps.symbols ?? new LtspiceSymbolIndex(defaultLtspiceLibDir(env));
  const now = deps.now ?? (() => new Date());

  server.registerTool(
    "easyeda_export_spice",
    {
      title: "Export EasyEDA Pro schematic as SPICE netlist",
      description: "Converts the live schematic into an LTspice-ready netlist using models.json and SPICE_* component attributes, and reports how every part was mapped. When nothing is unresolved it writes runs/<runId>/circuit.cir (DUT + optional test bench) under EASYEDA_SIM_DIR for LTspice's open_design/start_simulation.",
      inputSchema: {
        bench: z.string().min(1).optional().describe("Test bench name in <simDir>/benches (without .bench.cir) or a path relative to simDir."),
        runId: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional().describe("Run directory name; defaults to a timestamp."),
        write: z.boolean().default(true).describe("Write run files. false returns the netlist and report only."),
        groundNets: z.array(z.string().min(1)).optional().describe("Nets mapped to SPICE node 0; overrides models.json."),
        allPages: z.boolean().default(true),
        timeoutMs: z.number().int().positive().max(120_000).default(30_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ bench, runId, write, groundNets, allPages, timeoutMs }) => {
      try {
        const status = bridge.getStatus();
        const snapshot = await bridge.call("schematicSnapshot", { includeRaw: true, allPages }, timeoutMs) as SchematicSnapshot;
        const projectName = status.projectName ?? sheetAttribute(snapshot, "@Project Name");
        const simDir = resolveSimDir(projectName, env);
        const mappingPath = path.join(simDir, MAPPING_FILE_NAME);
        const { mapping, found } = await loadMappingFile(mappingPath);
        const documentName = status.documentName ?? sheetAttribute(snapshot, "@Schematic Name");
        const title = [projectName, documentName].filter(Boolean).join(" / ") || "EasyEDA schematic";
        const result = await buildSpiceNetlist(snapshot, {
          mapping,
          symbols,
          groundNets,
          title,
          resolveInclude: makeIncludeResolver(simDir)
        });

        const report = {
          ok: result.ok,
          simDir,
          mappingFile: { path: mappingPath, found },
          snapshotHash: result.snapshotHash,
          unresolved: result.unresolved,
          unverified: result.unverified,
          nodes: result.nodes,
          groundNets: result.groundNets,
          warnings: [...result.warnings, ...snapshot.warnings ?? []],
          components: result.components
        };

        if (!result.ok) {
          return ok(
            `${result.unresolved.length} component(s) could not be mapped to SPICE. Add models.json entries or SPICE_* attributes, then export again. No run files were written.`,
            { ...report, netlist: result.netlist }
          );
        }

        let files;
        if (write) {
          const id = runId ?? newRunId(now());
          files = await writeRun({ simDir, runId: id, dutNetlist: result.netlist, bench, resolution: report, title });
        }
        const unverifiedNote = result.unverified.length > 0 ? ` Unverified mappings: ${result.unverified.join(", ")}.` : "";
        return ok(
          files
            ? `Exported SPICE netlist to ${files.circuitPath}.${bench ? "" : " No bench was given, so add sources and analysis before simulating."}${unverifiedNote}`
            : `Built SPICE netlist (not written).${unverifiedNote}`,
          { ...report, files, netlist: result.netlist }
        );
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "easyeda_set_component_values",
    {
      title: "Write component values back to EasyEDA Pro",
      description: "Applies an approved batch of component value changes (e.g. from an LTspice optimization) to the live schematic. Each change carries the expected old value and is rejected if the schematic changed meanwhile. Use dryRun first to show the diff table; real writes need an explicit confirmation phrase. Parts with an LCSC number are marked SIM_PartStale=true because the value no longer matches the ordered part. Nothing is saved; use easyeda_confirmed_action save afterwards.",
      inputSchema: {
        changes: z.array(ValueChangeSchema).min(1).max(100),
        dryRun: z.boolean().default(false),
        confirmation: z.string().optional().describe("Required unless dryRun. Must include an explicit phrase such as \"I confirm\" or \"承認\"."),
        runId: z.string().optional().describe("Simulation run that justified the change; stamped as SIM_LastRun."),
        markStale: z.boolean().default(true),
        timeoutMs: z.number().int().positive().max(120_000).default(30_000)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ changes, dryRun, confirmation, runId, markStale, timeoutMs }) => {
      try {
        if (!dryRun && !confirmationRegex.test(confirmation ?? "")) {
          return fail(new Error("Value write-back was blocked. Show the dryRun diff to the user and pass their explicit confirmation (e.g. \"I confirm\" or \"承認\")."));
        }

        const invalid: Array<Record<string, string>> = [];
        const normalized = changes.flatMap((change) => {
          let value = change.value;
          if (change.key === "Value") {
            const kind = valueKindForDesignator(change.designator);
            if (kind) {
              const parsed = parseComponentValue(change.value);
              if (!parsed) {
                invalid.push({ designator: change.designator, value: change.value, reason: "Value is not a number." });
                return [];
              }
              value = formatEasyEdaValue(parsed.value, kind);
            }
          }
          return [{
            designator: change.designator,
            key: change.key,
            value,
            expected: change.expected,
            extra: runId ? { SIM_LastRun: runId } : undefined,
            extraIfSupplier: markStale && change.key === "Value" ? { SIM_PartStale: "true" } : undefined
          }];
        });

        if (invalid.length > 0) {
          const list = invalid.map((item) => `${item.designator}="${item.value}"`).join(", ");
          return fail(new Error(`Some values could not be parsed (${list}); nothing was written.`));
        }

        const result = await bridge.call("setComponentValues", { changes: normalized, dryRun }, timeoutMs) as { results: Array<{ status: string }> };
        const counts = countBy(result.results.map((item) => item.status));
        const summary = dryRun
          ? `Dry run: ${counts.planned ?? 0} planned, ${counts.unchanged ?? 0} unchanged, ${counts.rejected ?? 0} rejected.`
          : `Wrote values: ${counts.applied ?? 0} applied, ${counts.unverified ?? 0} unverified, ${counts.unchanged ?? 0} unchanged, ${counts.rejected ?? 0} rejected. Not saved yet.`;
        return ok(summary, { dryRun, counts, results: result.results });
      } catch (error) {
        return fail(error);
      }
    }
  );
}

/** The page frame ("sheet" component) carries project and schematic names that the bridge status may lack. */
function sheetAttribute(snapshot: SchematicSnapshot, key: string): string | undefined {
  for (const component of snapshot.components) {
    const value = component.attributes?.[key]?.trim();
    if (component.componentType === "sheet" && value) return value;
  }
  return undefined;
}

function countBy(items: string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const item of items) output[item] = (output[item] ?? 0) + 1;
  return output;
}
