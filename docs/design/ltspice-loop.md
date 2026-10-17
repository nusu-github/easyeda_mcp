# Design: EasyEDA Pro ⇄ LTspice simulation loop

Status: phase 1 implemented (`easyeda_export_spice`, `easyeda_set_component_values`). User guide: [../ltspice-loop.md](../ltspice-loop.md).

## 1. Goal

Let an AI assistant run this loop with a human approving every change to the design:

```text
EasyEDA Pro schematic ──extract──▶ SPICE netlist + test bench ──simulate──▶ LTspice
        ▲                                                                    │
        └──── approved value changes ◀── evaluate against spec ◀── results ──┘
```

The AI is the orchestrator. It holds two MCP servers at once:

| Side | MCP server | Status |
| --- | --- | --- |
| EasyEDA Pro | this repository (`easyeda-pro-mcp`) | exists; needs 2 new tools |
| LTspice 26.1+ | `ltspice-mcp-bridge.exe` (ships with LTspice) | exists; used as-is |

No third "orchestration server" is planned at first. The loop procedure lives in a Claude Code skill (`.claude/skills/sim-loop/`), and state lives in files on disk (§7).

### LTspice MCP tools used by the loop

Confirmed against LTspice 26.1.1 (`tools/list`):

- `open_design`, `set_design_content`, `get_design_content` — load and edit a netlist (`.cir`) file
- `start_simulation`, `is_simulation_running`, `get_spice_log` — run and read the log (`.meas` results are in the log)
- `get_raw_info`, `read_raw_waveforms`, `export_raw_waveforms` — read waveform data
- `status`, `attach`, `start_headless` — choose the user's GUI instance or a hidden one

The loop always works on **netlists, never `.asc` schematics**. LTspice's own docs warn that AI tools are bad at placing symbols and wiring; a generated netlist avoids that problem entirely.

## 2. Two input paths

**Path A — design schematic → generated netlist (primary).**
The normal EasyEDA schematic (the one that goes to PCB) is converted into a SPICE netlist by the new `easyeda_export_spice` tool. Requires the model mapping table (§3) because EasyEDA parts carry LCSC/MPN data, not SPICE models.

**Path B — EasyEDA simulation schematic → LTspice as a plug-in engine (later, experimental).**
EasyEDA Pro's API lets an extension act as a SPICE engine: `eda.sch_Event.addSimulationEnginePullEventListener` receives `SIMULATE_NETLIST`, and `eda.sch_SimulationEngine.pushData('SIMULATION_RESULT', …)` returns results to EasyEDA's waveform viewer. This only works on EasyEDA *simulation* pages (Ngspice symbols), not on the design schematic, and the result payload format is undocumented beyond one example. Out of scope for phase 1; worth a spike later because it would show LTspice results inside EasyEDA.

## 3. Model mapping

### 3.1 Resolution order

For each component, the first rule that matches wins:

1. **Instance attributes** on the EasyEDA component (`SPICE_Kind`, `SPICE_Model`, `SPICE_Include`, `SPICE_PinMap`). Travels with the design; good for one-offs.
2. **Project mapping file** `models.json` (§3.2), matched by LCSC part number (`supplierId`), then manufacturer part number (`manufacturerId`), then device name.
3. **Primitive defaults** by designator prefix: `R`, `C`, `L` (value only), `FB` (bead → inductor + resistor, optional).
4. **Ignore list**: mounting holes, fiducials, test points, logos (`H*`, `MH*`, `FID*`, `TP*`) are dropped. Connectors (`J*`, `P*`, `CN*`) are dropped but their nets keep their names so the test bench can drive them.
5. **Unresolved** → extraction stops with a report. The AI may *propose* entries (searching LTspice `lib/cmp/standard.*` and `lib/sym/**/*.asy`), but never silently guesses a model.

The resolution report lists every component with the rule that matched it, so a reviewer can see what was assumed.

### 3.2 Mapping file format

JSON (no new dependency; validated with zod).

```json
{
  "version": 1,
  "groundNets": ["GND", "AGND", "PGND"],
  "parts": [
    {
      "match": { "lcsc": "C123456" },
      "kind": "subckt",
      "model": "LT1013",
      "include": "LT1013.sub",
      "units": [
        { "pinMap": { "3": "In+", "2": "In-", "8": "V+", "4": "V-", "1": "OUT" } },
        { "pinMap": { "5": "In+", "6": "In-", "8": "V+", "4": "V-", "7": "OUT" } }
      ],
      "source": "LTspice lib/sym/OpAmps/LT1013.asy",
      "verified": true
    },
    {
      "match": { "mpn": "1N4148W" },
      "kind": "model",
      "prefix": "D",
      "model": "1N4148",
      "pinMap": { "1": "K", "2": "A" },
      "verified": false
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `primitive` (R/C/L from value), `model` (D/Q/M/J + `.model` name), `subckt` (X + `.subckt`), `ignore`, `short` (0 Ω link / jumper) |
| `pinMap` | EasyEDA **pin number** → SPICE port. For `subckt`, port names come from the LTspice symbol and are ordered by its `SpiceOrder`. Required for everything except 2-terminal primitives. |
| `units` | One `pinMap` per unit. A dual op-amp drawn as sub-parts in EasyEDA becomes two `X` instances (`XU1A`, `XU1B`) that share the power pins. Pins of all sub-parts with the same designator are merged first, so pin numbers are unique per designator. |
| `include` | A path that exists under the sim directory becomes absolute; anything else (e.g. `LT1013.sub`) is left for LTspice's library search. Defaults to the symbol's `SpiceModel`. |
| `params` | extra instance parameters (e.g. `Rser=10m` for a capacitor) |
| `verified` | set to `true` only by a human; unverified entries are allowed but flagged in every report |

### 3.3 Pin mapping — the risky part

Pin order mistakes produce a netlist that simulates fine and is wrong. Rules:

- ADI's `lib/sub/*.sub` files are **encrypted** (`<Binary File>` header), so the `.subckt` line cannot be read. The authoritative port order is the LTspice symbol (`lib/sym/**/<model>.asy`): `PINATTR PinName` + `PINATTR SpiceOrder`. The tool reads that to build the port list.
- Mapping EasyEDA pin names (`+IN`, `IN+`, `INA+`, `VCC`, …) to LTspice pin names is a proposal step done by the AI; the human confirms it and sets `verified`.
- The extractor checks: every port in the symbol is mapped exactly once, every mapped EasyEDA pin exists, and unmapped EasyEDA pins are either NC or listed explicitly in `ignorePins`.
- For third-party vendor models (plain-text `.lib`), the `.subckt` line is parsed directly and must agree with `pinMap`.
- Some LTspice library files are UTF-16 (e.g. `lib/cmp/standard.bjt`); readers must detect encoding.

### 3.4 Value conversion

EasyEDA `Value` strings → SPICE numbers, and back for write-back:

| EasyEDA | SPICE | Note |
| --- | --- | --- |
| `10kΩ`, `10K` | `10k` | strip `Ω` |
| `1MΩ` | `1Meg` | **`M` is milli in SPICE**; LTspice also warns about this |
| `100nF`, `0.1uF`, `100n` | `100n` | `µ`/`μ` → `u` |
| `4.7uH ±20%` | `4.7u` | tolerance and voltage ratings are dropped (kept in report) |
| `DNP`, `NC` | component removed | |

Unparseable values are unresolved components (§3.1 step 5).

## 4. Test bench

The design schematic has no sources, loads, or analysis commands. Those live in a separate, hand/AI-edited bench file, joined to the circuit by **EasyEDA net name**:

```text
sim/
  models.json
  benches/
    buck_load_step.bench.cir     # sources, loads, .tran, .meas, .param, .step
    buck_load_step.spec.json     # pass/fail targets on .meas results
  runs/<run-id>/...
```

A bench references nets by name (`VIN`, `VOUT`, `FB`). The generated netlist is:

```text
* --- generated from EasyEDA (do not edit) ---
<DUT netlist from easyeda_export_spice>
* --- bench ---
.include benches/buck_load_step.bench.cir
.end
```

`spec.json` example:

```json
{ "targets": [
  { "meas": "vout_avg",    "min": 3.25, "max": 3.35 },
  { "meas": "vout_ripple", "max": 0.03 },
  { "meas": "t_settle",    "max": 200e-6 }
] }
```

Specs make "is it better?" a deterministic check instead of the AI's opinion.

## 5. Loop procedure

| Step | Who | What | Gate to continue |
| --- | --- | --- | --- |
| 0. Preflight | AI | `easyeda_doctor`; LTspice `status`, then `attach` (GUI) or `start_headless` | both healthy |
| 1. Extract | AI | `easyeda_export_spice` → DUT netlist + resolution report | zero unresolved components |
| 2. Assemble | AI | write `runs/<id>/circuit.cir`; record EasyEDA snapshot hash | — |
| 3. Simulate | AI | `open_design` → `start_simulation` → poll `is_simulation_running` → `get_spice_log` | log has no errors; all spec `.meas` present |
| 4. Evaluate | AI | compare `.meas` to `spec.json`; inspect waveforms with `read_raw_waveforms` only for named signals | all pass → step 8 |
| 5. Propose | AI | choose changes; prefer one `.step` sweep in LTspice over many loop turns; snap to E24/E96 | — |
| 6. Approve | **Human** | review diff table: designator, old → new, reason, sim evidence | explicit approval |
| 7. Write back | AI | `easyeda_set_component_values` with expected old values; then back to step 1 | re-extraction shows the new values |
| 8. Report | AI | summary + `runs.jsonl` entry | — |

Stop conditions: all specs pass, the user stops, `maxIterations` (default 5) reached, or two iterations in a row without improvement.

### Write-back rules

- Only `Value` (and other `otherProperty` keys explicitly listed) change. Implemented with `eda.sch_PrimitiveComponent.modify(id, { otherProperty })`.
- Each change carries the expected old value. If the live value differs (the user edited meanwhile), that change is rejected — no last-writer-wins.
- **BOM staleness:** changing `Value` does not change the LCSC part. Phase 1 marks the component (`SIM_PartStale=true`) and lists it in the report; it does not pick a replacement part. Replacement-part search is a later phase.
- The change is not saved automatically. Saving stays a separate `easyeda_confirmed_action save` step.
- Optional: stamp `SIM_LastRun=<run-id>` on changed components for traceability.

## 6. New EasyEDA MCP tools (phase 1)

| Tool | Kind | Input | Output |
| --- | --- | --- | --- |
| `easyeda_export_spice` | read-only | `mappingPath`, `scope` (page/all), `groundNets?` | netlist text, resolution report, unresolved list, snapshot hash |
| `easyeda_set_component_values` | mutating, confirmation required | `changes: [{designator, key, expected, value}]`, `confirmation` | applied / rejected per change |

`easyeda_export_spice` builds on the component/net graph already produced in `src/schematic/analysis.ts`; the mapping and value conversion run in the Node server, not in the extension, so they are unit-testable.

## 7. Run records

```text
runs/<yyyymmdd-hhmmss>/
  circuit.cir         # exact netlist simulated
  resolution.json     # which rule mapped each part
  circuit.log         # LTspice log
  results.json        # .meas values + spec verdicts
  proposal.json       # proposed changes and the human decision
runs.jsonl            # one line per run
```

`.raw` files stay in the run directory but are not committed.

## 8. Out of scope (phase 1)

- PCB parasitics, thermal effects
- Drawing or editing LTspice `.asc` schematics
- Digital / mixed-signal ICs without SPICE models
- Path B (EasyEDA simulation-engine plug-in)
- Automatic replacement-part selection

## 9. Decisions

| Topic | Decision |
| --- | --- |
| Mapping storage | Both: `models.json` is the default; `SPICE_*` instance attributes override it (§3.1) |
| First circuit class | Op-amp circuits (filters, amplifiers). Day-one model kinds: R/C/L primitives + `subckt` op-amps with multi-unit `units`; `model` (diodes) as a stretch goal |
| BOM staleness | Mark `SIM_PartStale=true` and report; no replacement-part search in phase 1 |
| Approval | One approval per proposal (batch diff table); the reviewer may drop individual rows |

| Sim directory | `EASYEDA_SIM_DIR`, falling back to `~/Documents/easyeda-sim/<project-name>/` |

## 10. Verification so far

- Unit tests cover value conversion, `.asy` parsing (UTF-16 and 8-bit), mapping resolution, multi-unit emission, pin-map validation, run files and the write-back guard.
- A generated inverting amplifier (R1 = 10 kΩ, R2 = 47 kΩ, LT1013 as two units) ran in LTspice 26.1.1 batch mode and measured gain 4.70.
- Verified on EasyEDA Pro 3.2.206 with an LCSC resistor (C25804): the part value lives in `otherProperty.Value` (the component `name` is the template `={Value}`); `modify` with the merged `otherProperty` updates the displayed value and keeps every other attribute; a stale `expected` is rejected; the change is undoable with Ctrl+Z; nothing is saved.
- The bridge status carries no project name, so the sim directory name falls back to the page frame's `@Project Name` attribute.
