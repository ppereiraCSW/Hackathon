# BRIEF — AERO HACKATHON: Humans X AI

> Résumé of what the hackathon asks for, built from the kickoff deck
> `Hackathon_Humans_X_AI 1.pptx` (8 slides, 1.2 MB), text extracted locally with
> `data/hackathon-deck/extract.cjs`. Nothing was uploaded.
> Deck authors: **ASD · Skyline & Borg**.
> Full extracted text: `harness/data/hackathon-deck/deck-text.md`.

---

## 1. One-line ask

**A one-day hackathon: build a simplified avionics system, end to end — the way
certification-grade systems are actually built.** "Humans powered with AI."

## 2. The challenge — three layers, one pipeline

Scaled down to fit a single day, but built properly:

| # | Layer | What it must do |
|---|-------|-----------------|
| 01 | **Backend** | Core flight-data logic and communication between components. |
| 02 | **Frontend** | A cockpit-style display presenting live flight data. |
| 03 | **Embedded** | Firmware running on real or simulated hardware, acquiring sensor data. |

## 3. Reference implementation — what "working" looks like

The deck's reference solution is a **Secondary Flight Display (SFD)**:

```
Hardware            Embedded           Backend              Frontend
real or simulated → tiny-RTOS     →   flight-data logic →  reads in real time
sensor acquisition    firmware          + component comms    cockpit display
```

The SFD is the frontend output; the three components must talk to each other.

## 4. Optional stretch goals (if you finish early)

1. **STM32** — flash the logic onto a real embedded target.
2. **Gamepad** — analog stick input for finer control.
3. **Mouse & keyboard** — the reliable baseline, always available.

## 5. AI tooling setup (do this *before* building)

Three steps to get the **on-prem AI harness** running on your machine:

1. **SSH key** — configure your Bitbucket SSH key.
2. **LiteLLM key** — generate one (log in with SSO) at the LiteLLM Dashboard.
   * Team: `Company Team`
   * Key Name: whatever you want
3. **Clone & run** — `git clone` the repo, then run `run.cmd` (Windows) / `run.sh`:

   `https://bitbucket.critical.pt/projects/AIACCELERATION/repos/criticalpiharness_gui/browse`

Further reading: *pi cockpit — João Pedro Simões — Confluence*.

## 6. Prizes

| Prize | Awarded for |
|-------|-------------|
| **First to Fly** | First team to get a fully working solution up and running. |
| **Extra Mile** | Built something beyond the brief — nobody asked, you did it anyway. |
| **The Hive** | Best automated pipeline for integrating changes — features, scaling, and beyond. |

## 7. The day (one day, fixed clock)

**Morning**

| Time | Session | Notes |
|------|---------|-------|
| 09:00–09:30 | Arrival: Boarding | Check-in, merch, find your table |
| 09:30–09:50 | Pre-Flight Briefing | Welcome, rules, theme reveal |
| 09:50–10:00 | Crew Assignment | Teams pick approach, assign roles |
| 10:00–12:30 | **Flight Block 1: Build the Solution** | Core challenge, moderators circulate |
| 12:30–13:30 | Fuel Stop | Pizza and drinks |

**Afternoon**

| Time | Session | Notes |
|------|---------|-------|
| 13:30–15:30 | **Flight Block 2: Get It Flying** | Core challenge continues |
| 15:30–16:00 | Final Approach | Wrap up code, finish docs, **submit repo** |
| 16:00–16:45 | Show & Tell: Cockpit Demos | Lightning demos, selected teams |
| 16:45–17:15 | Top Gun Trophies | Moderators announce prizes |
| 17:15–17:30 | The End: Closing the Airport | Closing remarks, group photo |

**Build time available: 2 h 30 + 2 h 00 = 4 h 30.**
Hard stop and repo submission: **15:30–16:00**.

## 8. What the deck does *not* say (open questions)

These are not answered anywhere in the deck — resolve with a moderator / table lead:

- **Submission format** — "submit repo" is the only instruction: where does it point,
  and does it have to be a branch, a tag, or `main`?
- **Acceptance criteria** — no functional spec: which flight data (attitude, altitude,
  airspeed, heading?), units, update rate, failure behaviour. "Simplified" is undefined.
- **Sensor source** — what simulated hardware provides the input, if any; is there a
  provided fake sensor bus, or do we invent one?
- **Tech stack** — no language/framework mandate; the reference mentions a *tiny-RTOS*
  for the embedded layer but does not name it.
- **Interface between layers** — protocol, message format, and who owns the contract.
- **"The Hive"** — what counts as an "automated pipeline for integrating changes"
  (CI, PR checks, AI-assisted review?) is left open.
- **Team size** — "find your table": not stated.

## 9. Deck oddity worth knowing

Slide 6's speaker note ("Optional stretch goals for teams who finish early") is a
**copy-paste of slide 5's note** — the AI setup slide has no note of its own. Read
slide 6 as mandatory setup, not optional, since it says "you will use during the
hackathon".

## 10. Suggested first moves on `sandbox`

1. Decide the **layer interfaces first** (message schema + transport) — it is the one
   thing all three layers depend on and the cheapest place to be wrong.
2. Build a **walking skeleton** end-to-end (fake sensor → backend → frontend showing one
   number) before adding fidelity — this is literally the "First to Fly" prize.
3. Keep the embedded layer runnable **simulated** from minute one; only flash STM32 if
   the pipeline already runs.
4. Reserve the last 30 min of Block 2 for docs + repo submission, per the schedule.
