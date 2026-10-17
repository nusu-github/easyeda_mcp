---
name: sim-loop
description: Simulate the live EasyEDA Pro schematic in LTspice and tune component values against a spec, with the user approving every write-back. Use when the user wants to simulate, verify, or optimize an EasyEDA circuit in LTspice. Needs the easyeda and ltspice MCP servers.
---

# EasyEDA ⇄ LTspice simulation loop

Full reference: `docs/ltspice-loop.md`. Follow these steps in order and do not skip the gates.

## 0. Preflight

- `easyeda_doctor` must show the extension connected and a schematic open.
- LTspice: `status`; `attach` to the user's GUI if one is running, else `start_headless`.
- Ask which bench to use if the user did not say. Benches live in `<simDir>/benches/<name>.bench.cir`, specs in `<name>.spec.json`.

## 1. Extract

Call `easyeda_export_spice` with `bench`.

- If `ok` is false: stop. For each unresolved part, propose a `models.json` entry or `SPICE_*` attributes. Find candidate models in the LTspice library (`%LOCALAPPDATA%\LTspice\lib\sym\**\<model>.asy` for port names and `SpiceOrder`; `lib/cmp/standard.*` for diodes/transistors). Show the proposed pin map next to the EasyEDA pin names (`easyeda_get_component_pins`) and ask the user to confirm before writing the file. Never set `verified: true` yourself.
- If `unverified` is not empty, tell the user which parts rely on unverified pin maps.
- If a bench refers to a net that is missing from `nodes`, fix the bench, not the DUT.

## 2. Simulate

- `open_design` with `files.circuitPath`, then `start_simulation`.
- Poll `is_simulation_running` until false, then `get_spice_log`.
- Any error or missing `.meas` in the log: stop and report; do not tune on a broken run.
- Use `read_raw_waveforms` only for specific signals, with `max_values` set.

## 3. Evaluate

Compare each `.meas` value with `spec.json` targets. Report a table: measurement, value, target, pass/fail. If everything passes, go to step 6.

## 4. Propose

- Prefer one LTspice `.step param` sweep (edit the run's `circuit.cir` with `set_design_content`, never the DUT section) over many loop iterations.
- Snap results to E24 (E96 for 1% resistors) and state the expected effect.
- Present a diff table: designator, current value, new value, reason, simulated evidence.
- Then call `easyeda_set_component_values` with `dryRun: true`, `expected` = current values, and `runId`. Show its result.

## 5. Approve and write back

- Wait for the user's explicit approval of the batch. They may drop rows.
- Call `easyeda_set_component_values` again with the approved rows and the user's confirmation words in `confirmation`.
- Report `rejected` rows (the schematic changed meanwhile) and `SIM_PartStale` parts (LCSC part must be re-selected by the user).
- Go back to step 1 to re-extract and re-simulate. Stop after 5 iterations or two iterations without improvement.

## 6. Finish

- Summarize: runs, final measurements vs spec, changed parts, stale LCSC parts.
- Do not save the EasyEDA document unless the user asks; then use `easyeda_confirmed_action` with `save`.
