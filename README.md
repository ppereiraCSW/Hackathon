# Hackathon — Humans X AI

Work repo for the **AERO HACKATHON: Humans X AI** — a one-day hackathon to build a
simplified avionics system end to end. Organised by ASD · Skyline & Borg.

> Branch policy: **all work goes on `sandbox` first.** Nothing is merged to `main`
> without an explicit decision to do so.

---

## The challenge

Build a simplified avionics system, scaled down to fit one day but built the way
certification-grade systems are — across three layers:

| # | Layer | Responsibility |
|---|-------|----------------|
| 01 | **Backend** | Core flight-data logic and communication between components |
| 02 | **Frontend** | A cockpit-style display presenting live flight data |
| 03 | **Embedded** | Firmware on real or simulated hardware, acquiring sensor data |

Reference artefact is a **Secondary Flight Display (SFD)**:

```
Hardware            Embedded           Backend              Frontend
real or simulated → tiny-RTOS     →   flight-data logic →  reads in real time
sensor acquisition    firmware          + component comms    cockpit display
```

**Stretch goals** (only once the pipeline runs end to end): flash an STM32, add a
gamepad analog stick, or fall back to mouse & keyboard.

Prize categories: **First to Fly** (first fully working solution), **Extra Mile**
(beyond the brief), **The Hive** (best automated pipeline for integrating changes).

## Repository contents

| Path | What it is |
|------|------------|
| `Hackathon_Humans_X_AI 1.pptx` | The kickoff / briefing deck (8 slides, 1.2 MB). Binary — ask for an extracted-text summary instead of a diff. |
| `BRIEF.md` | Condensed written brief derived from the deck: the ask, the three layers, the day's timetable, prizes, setup steps, and the open questions the deck leaves unanswered. |
| `README.md` | This file. |

## The day

**Morning** — 09:00 arrival & check-in · 09:30 pre-flight briefing · 09:50 crew
assignment · **10:00–12:30 Flight Block 1: Build the Solution** · 12:30 fuel stop.

**Afternoon** — **13:30–15:30 Flight Block 2: Get It Flying** · 15:30–16:00 final
approach (wrap up code and docs) · 16:00–16:45 cockpit demos · 16:45–17:15 prizes ·
17:15 close.

Total build time: **4 h 30**. Hard stop for finishing the repo: **15:30–16:00**.

## AI tooling setup

Do this before building:

1. **SSH key** — configure your Bitbucket SSH key.
2. **LiteLLM key** — generate one (SSO login) at the LiteLLM Dashboard.
   Team `Company Team`, key name of your choosing.
3. **Clone & run** the harness, then start it:

   ```bash
   git clone https://bitbucket.critical.pt/projects/AIACCELERATION/repos/criticalpiharness_gui/browse
   run.cmd      # Windows
   ./run.sh     # macOS / Linux
   ```

Further reading: *pi cockpit* — João Pedro Simões, Confluence.

## Working in this repo

```bash
git checkout sandbox          # always work here
git status                    # check before committing
git add <files>
git commit -m "..."
git push origin sandbox
```

Identity is set repo-locally only (not globally):

```
user.name  = prpereiraCSW
user.email = paulo.pereira@criticalsoftware.com
```

### Notes and gotchas

- `.pptx` is a binary: it does not diff. Keep the deck as reference material; put
  anything that changes in Markdown or code.
- **Do not commit generated output** — extracts, builds, logs, `node_modules/`,
  virtual environments. Add a `.gitignore` before the first code lands.
- There is no `main` branch on the remote yet; `sandbox` is currently the default.
- Nothing in this repo is sent anywhere without asking first.

## Open questions

The deck does not define these — resolve with a moderator / table lead:

- **Submission** — "submit repo" only: which target, branch or tag?
- **Acceptance criteria** — which flight data (attitude, altitude, airspeed, heading?),
  what units, what update rate, what failure behaviour. "Simplified" is undefined.
- **Sensor source** — is simulated hardware provided, or invented by the team?
- **Tech stack** — no language or framework is mandated; the embedded layer is
  described only as a "tiny-RTOS".
- **Interfaces** — protocol, message format, and who owns the contract between layers.
- **"The Hive"** — what counts as an automated pipeline for integrating changes.
- **Team size** — not stated ("find your table").

## Licence / confidentiality

Internal Critical Software hackathon material. Do not redistribute outside the
company.
