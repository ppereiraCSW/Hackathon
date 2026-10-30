# Rules: common (every agent, every task)

## 1. The system in one picture

```
USB gamepad --HID (WinMM fallback)--> host/pad-reader.ps1
    --TCP :5556, 17-byte pad frames, 50 Hz--> QEMU mps2-an385 UART1 (RX)
        bare-metal Cortex-M3 firmware: 50 Hz flight model -> 6 A429 words
    QEMU UART0 (TX) --TCP :5555, 4 bytes LE per word--> backend (Node, zero deps)
        decode -> engineering units -> validity/freshness
    HTTP :8090 --SSE /events (50 Hz) + /config-events--> /sfd and /config pages
```

| Layer | Paths | Agent |
|---|---|---|
| Embedded | `firmware/`, `host/` | embedded |
| Backend | `backend/`, `test/a429.test.mjs`, `test/state.test.mjs` | backend |
| Frontend | `frontend/` | frontend |
| Contracts and glue | `shared/`, `tools/`, rest of `test/`, `docs/`, `ai/`, CI, root files | integrator |
| Review | nothing (read-only) | reviewer |

The authoritative list is `ai/ownership.json` (longest matching entry wins).
`node tools/check-ownership.mjs` shows the owner of every changed file.

## 2. Ownership

- Edit only the paths your agent owns. Read anything.
- A change needed outside your paths: stop and hand it to the integrator with the
  exact file, the change and why. Do not make it yourself.
- `shared/` is the contract between layers. Only the integrator edits it, and only
  together with every layer that depends on the changed part.

## 3. Decisions already taken (do not reopen without the user)

From `docs/PLAN.md`, agreed 2026-10-30:

| # | Decision |
|---|---|
| R2 | Embedded layer is bare-metal Cortex-M3 firmware in QEMU `mps2-an385`. No RTOS. |
| R4 | Firmware emits bit-exact ARINC 429 32-bit words. Word-framed transport, no bit timing. |
| R5 | The backend is decoupled: it must not know or need the gamepad, the firmware or QEMU. |
| R6 | The backend only decodes, converts BNR to engineering units and judges validity/freshness. No filtering, smoothing or derived values. |
| R7 | Sliders configure the display (range and visibility). They never override a value. |
| R9 | Six labels (octal): pitch 324, roll 325, heading 314, baro alt 204, CAS 206, V/S 212. |
| R10 | Two pages served by the backend: `/config` and `/sfd`. |
| — | Stack: Node 24 (engines `>=22`), C for firmware, PowerShell + .NET for host. No frameworks, no npm packages. |
| — | Heading and altitude are integrated in the firmware, not the backend. |

Changing any of these is the user's decision. Propose it; do not do it.

## 4. Dependencies

- **No npm packages.** `package.json` has no `dependencies`; keep it that way.
  Use Node built-ins only (`node:http`, `node:net`, `node:test`, ...).
- **No frontend frameworks or CDNs.** Plain HTML, CSS, ES modules, Canvas, SVG.
- **No new toolchains.** Arm GNU Toolchain 14.2.Rel1, QEMU 11.1.0, Node 24.
- Adding any dependency needs the user's approval first.

## 5. Environment facts

- Windows host. Toolchain and QEMU are **not on PATH**; `firmware/build.mjs`
  defaults to the winget install paths, overridable with environment variables:
  - `ARM_TOOLCHAIN_BIN`, default `C:\Program Files (x86)\Arm GNU Toolchain arm-none-eabi\14.2 rel1\bin`
  - `QEMU_BIN`, default `C:\Program Files\qemu`
  - CI (Linux) sets both to `/usr/bin` and uses the apt packages.
- Not every machine has the toolchain. Check with `node tools/chain.mjs --stage M0`.
  Without it, firmware stages are skipped locally and covered by CI. Installing it
  needs the user's approval.
- Node: `engines` says `>=22`; CI runs Node 24. Some dev machines run newer (26);
  the code uses only stable built-ins.
- Ports: HTTP `8090`, A429 in `5555`, pad frames `5556`. Tests use `18500+`.
- The repo may sit under a path containing spaces. Pass paths as separate argv
  elements, never glued into one flag string.
- The gamepad is `HID\VID_0079&PID_181C`, DirectInput only (XInput cannot see it),
  four axes X Y Z R.

## 6. Evidence, not claims

- Every "it works" needs a command and its output. Run it; quote it.
- Baseline: `npm test` passes **64/64**. A change that lowers that is not done.
- When a number matters (rate, count, size), measure it. `docs/ARCHITECTURE.md` §5
  records a timer bug that looked correct and was 50x wrong (0.76 Hz vs 50 Hz).
- Report failures as failures, with the output. Never mark a skipped step as done.

## 7. Git

- Work on the current feature branch (now `AI-framework`). `sandbox` is the
  integration branch. There is no `main`; never create or merge to one unasked.
- Never push, force-push, rebase shared history or change git config unless the
  user asks in this conversation.
- Before committing: `node tools/check-ai.mjs` and `node tools/check-ownership.mjs --staged`.
  The pre-commit hook in `.githooks/` runs both once enabled with `npm run hooks:install`
  (that sets `core.hooksPath`; only the user runs it).
- CI (`.github/workflows/ci.yml`) runs the framework checks, `npm test` and the
  firmware stages of the run chain on every push and pull request.
- Commit style: one imperative sentence, capitalised, no prefix, no trailing
  period. Example from history: `Fix startup race and pad reader robustness`.
- Never commit generated output: `firmware/build/`, `node_modules/`,
  `package-lock.json`, `*.log`, `data/`, `.env*`. Exception: `shared/capture.a429`
  is a committed test fixture.
- `Hackathon_Humans_X_AI 1.pptx` is binary reference material. Do not edit it.

## 8. Known discrepancies in the repo

None open. The stale comments and docs found on 2026-10-30 (pad frame length, the
never-built qemu.mjs tool, the labels.json generator claim, `pad.h` button names, WinMM
wording) were fixed on the `AI-framework` branch. `firmware/src/flight.h` now
asserts at compile time that its button masks equal `pad.h`'s.

When you find a new one: fix it if you own the file, otherwise list it here and
tell the integrator.

## 9. Confidentiality

Internal Critical Software hackathon material. Send nothing from this repo to an
external service without the user's explicit approval.
