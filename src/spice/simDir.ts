import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const MAPPING_FILE_NAME = "models.json";

/** EASYEDA_SIM_DIR, or ~/Documents/easyeda-sim/<project-name>. */
export function resolveSimDir(projectName: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (env.EASYEDA_SIM_DIR) {
    return path.resolve(env.EASYEDA_SIM_DIR);
  }
  const project = (projectName ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "default";
  return path.join(homedir(), "Documents", "easyeda-sim", project);
}

export function newRunId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function benchPath(simDir: string, bench: string): string {
  if (path.isAbsolute(bench) || /[\\/]/.test(bench)) {
    return path.resolve(simDir, bench);
  }
  return path.join(simDir, "benches", bench.endsWith(".cir") ? bench : `${bench}.bench.cir`);
}

/** Model includes that exist relative to the sim directory become absolute; others are left for LTspice's own lib search. */
export function makeIncludeResolver(simDir: string): (include: string) => string {
  return (include) => {
    const candidate = path.resolve(simDir, include);
    return existsSync(candidate) ? candidate : include;
  };
}

export type RunFiles = {
  runDir: string;
  dutPath: string;
  circuitPath: string;
  resolutionPath: string;
  benchPath?: string;
};

export async function writeRun(options: {
  simDir: string;
  runId: string;
  dutNetlist: string;
  bench?: string;
  resolution: unknown;
  title: string;
}): Promise<RunFiles> {
  const runDir = path.join(options.simDir, "runs", options.runId);
  if (await exists(runDir)) {
    throw new Error(`Run directory already exists: ${runDir}`);
  }
  await mkdir(runDir, { recursive: true });

  let benchFile: string | undefined;
  let benchText = "";
  if (options.bench) {
    benchFile = benchPath(options.simDir, options.bench);
    try {
      benchText = await readFile(benchFile, "utf8");
    } catch {
      throw new Error(`Test bench not found: ${benchFile}`);
    }
  }

  const dutPath = path.join(runDir, "dut.cir");
  const circuitPath = path.join(runDir, "circuit.cir");
  const resolutionPath = path.join(runDir, "resolution.json");
  const circuit = [
    `* ${options.title}`,
    "* --- DUT (generated from EasyEDA, do not edit) ---",
    options.dutNetlist.trimEnd(),
    ...(benchFile ? [`* --- bench: ${benchFile} ---`, stripEnd(benchText)] : ["* --- no bench: add sources, analysis and .meas before simulating ---"]),
    ".end",
    ""
  ].join("\n");

  await writeFile(dutPath, options.dutNetlist, "utf8");
  await writeFile(circuitPath, circuit, "utf8");
  await writeFile(resolutionPath, `${JSON.stringify(options.resolution, null, 2)}\n`, "utf8");
  return { runDir, dutPath, circuitPath, resolutionPath, benchPath: benchFile };
}

function stripEnd(text: string): string {
  return text.replace(/^\s*\.end\s*$/gim, "").trimEnd();
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
