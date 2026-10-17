# LTspice Loop

Use this page to simulate an EasyEDA Pro schematic in LTspice and write tuned values back, with your AI assistant doing the plumbing and you approving every change.

```text
EasyEDA Pro ──easyeda_export_spice──▶ circuit.cir ──LTspice MCP──▶ .meas results
     ▲                                                                 │
     └──── easyeda_set_component_values (after your approval) ◀────────┘
```

Phase 1 targets op-amp circuits: R/C/L parts plus op-amps (including dual/quad parts drawn as sub-parts). Design notes: [design/ltspice-loop.md](./design/ltspice-loop.md).

## Setup

1. Install LTspice 26.1 or newer. It ships its own MCP server, `ltspice-mcp-bridge.exe`.
2. Register both MCP servers in your client. For Claude Code:

   ```bash
   claude mcp add --scope user easyeda -- node /absolute/path/to/easyeda_mcp/dist/index.js
   ```

   ```bash
   claude mcp add --scope user ltspice -- "C:\Users\<username>\AppData\Local\Programs\ADI\LTspice\ltspice-mcp-bridge.exe"
   ```

3. Optionally set `EASYEDA_SIM_DIR` for the MCP server. Without it, files go to `~/Documents/easyeda-sim/<project-name>/`.
4. Optionally set `LTSPICE_LIB_DIR` if your LTspice library is not in `%LOCALAPPDATA%\LTspice\lib`.

## Sim Directory

```text
<EASYEDA_SIM_DIR>/
  models.json                    # part → SPICE model mapping
  models/                        # your own vendor .lib files (optional)
  benches/
    inverting_gain.bench.cir     # sources, analysis, .meas
    inverting_gain.spec.json     # pass/fail targets
  runs/<runId>/
    circuit.cir                  # exact netlist simulated (DUT + bench)
    dut.cir                      # generated DUT only
    resolution.json              # how each part was mapped
```

## Mapping Parts to Models

Each part is mapped by the first rule that matches:

1. `SPICE_*` attributes on the component in EasyEDA
2. an entry in `models.json`, matched by LCSC number, then manufacturer part number, then device name
3. R, C, L designators: the `Value` field is used directly
4. connectors (`J`, `P`, `CN`) and mechanical parts (`H`, `MH`, `FID`, `TP`) are dropped

Anything else stops the export with a list of unresolved parts. The tool never guesses a model.

### `models.json`

```json
{
  "version": 1,
  "groundNets": ["GND", "AGND"],
  "parts": [
    {
      "match": { "lcsc": "C123456" },
      "kind": "subckt",
      "model": "LT1013",
      "units": [
        { "pinMap": { "3": "In+", "2": "In-", "8": "V+", "4": "V-", "1": "OUT" } },
        { "pinMap": { "5": "In+", "6": "In-", "8": "V+", "4": "V-", "7": "OUT" } }
      ],
      "source": "LTspice lib/sym/OpAmps/LT1013.asy",
      "verified": true
    },
    {
      "match": { "mpn": "OPA2340" },
      "kind": "subckt",
      "model": "OPA2340",
      "include": "models/opa2340.lib",
      "ports": ["In+", "In-", "V+", "V-", "OUT"],
      "pinMap": { "3": "In+", "2": "In-", "8": "V+", "4": "V-", "1": "OUT" },
      "ignorePins": ["5", "6", "7"],
      "verified": false
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `primitive`, `model` (D/Q/M/J with a `.model`), `subckt`, `ignore`, `short` |
| `model` | SPICE model or subcircuit name |
| `include` | library file. A path that exists under the sim directory is used as is; a bare name such as `LT1013.sub` is left for LTspice's library search. For LTspice's own parts it can be omitted. |
| `ports` / `symbol` | Port order. Without `ports`, the order comes from the LTspice symbol (`symbol`, or a symbol named like `model`) via its `SpiceOrder`. |
| `pinMap` / `units` | EasyEDA pin number → port name. Use `units` for multi-unit parts: one `X` instance per unit, sharing power pins. |
| `ignorePins` | pins that are allowed to stay unmapped |
| `verified` | set to `true` only after a person checked the pin map. Unverified parts are listed in every export. |

The export fails if a port is unmapped or mapped twice, if a pin number does not exist on the EasyEDA symbol, or if a connected pin is left out of the pin map.

### Component Attributes

For one-off parts, add attributes to the component in EasyEDA instead:

| Attribute | Example |
| --- | --- |
| `SPICE_Kind` | `subckt` (or `ignore`, `dnp`) |
| `SPICE_Model` | `LT1013` |
| `SPICE_Include` | `models/myamp.lib` |
| `SPICE_Ports` | `In+,In-,V+,V-,OUT` |
| `SPICE_PinMap` | `3=In+,2=In-,8=V+,4=V-,1=OUT;5=In+,6=In-,8=V+,4=V-,7=OUT` (`;` separates units) |
| `SPICE_Params` | `Rser=10m` |
| `SPICE_Verified` | `true` |

## Test Bench

The schematic has no sources or analysis commands, so they live in a bench file that refers to nets by their EasyEDA names (ground nets become node `0`):

```text
* benches/inverting_gain.bench.cir
V1 VIN 0 SINE(0 0.1 1k) AC 1
VP VCC 0 15
VN VEE 0 -15
.tran 0 3m 1m
.meas tran vout_pp PP V(VOUT)
.meas tran gain PARAM vout_pp/0.2
```

```json
{ "targets": [{ "meas": "gain", "min": 4.6, "max": 4.8 }] }
```

The export response includes `nodes`, the EasyEDA net → SPICE node map, in case a net name had to be changed (for example `+5V` becomes `P5V`).

## The Loop

1. `easyeda_doctor`, and LTspice `status` / `attach` (or `start_headless`)
2. `easyeda_export_spice` with `bench` → fix any `unresolved` parts first
3. LTspice `open_design` on `files.circuitPath`, then `start_simulation`, poll `is_simulation_running`, read `get_spice_log`
4. Compare the `.meas` results with `spec.json`
5. Prefer a `.step` sweep inside LTspice to find values, then pick E24/E96 values
6. `easyeda_set_component_values` with `dryRun: true` → review the diff table → run again with your confirmation
7. Export and simulate again to confirm, then save with `easyeda_confirmed_action`

In Claude Code, the `sim-loop` skill in this repository walks through these steps.

## Limits

- No PCB parasitics or thermal effects.
- No digital ICs without SPICE models.
- The loop edits netlists only, never LTspice `.asc` schematics.
- Changing `Value` does not change the LCSC part; such parts are marked `SIM_PartStale=true` for you to re-select.
