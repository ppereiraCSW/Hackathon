---
name: commit-and-review
description: Review a change against the layer rules, then commit it with the repository's message style. Use before every commit, or when asked to review a diff or branch.
---

# Skill: review and commit

Facts come from `ai/rules/`. Committing and pushing need the user's go-ahead;
pushing always needs an explicit request.

## 1. Look at the change

```bash
git status
git diff            # unstaged
git diff --staged   # staged
```

Group the changed files by owning agent (`ai/rules/common.md` §1).

## 2. Review checklist

### Every change
- [ ] Each file is owned by the agent that changed it, or the integrator ran the change.
- [ ] No recorded decision reopened (`common.md` §3) without the user's approval.
- [ ] No new dependency, framework, CDN or toolchain.
- [ ] No generated output staged (`firmware/build/`, `node_modules/`, logs, `.env*`).
- [ ] No secrets, tokens, personal paths or machine names added.
- [ ] Rules and docs updated if a stated fact changed.
- [ ] `build-and-test` run at the right scope, with output.

### Embedded (`ai/rules/embedded.md`)
- [ ] Builds with zero warnings; no libc, no heap.
- [ ] Timing untouched, or re-measured with `probe-rate`.
- [ ] Pad frame and A429 output byte-identical to their consumers.
- [ ] Label/LSB defines still mirror `shared/labels.json`.

### Backend (`ai/rules/backend.md`)
- [ ] Still decode + convert + validity only. No filtering or derived values.
- [ ] No reference to QEMU, the pad or firmware.
- [ ] Wire input never throws; errors counted.
- [ ] SSE/REST shapes unchanged, or changed through the integrator.
- [ ] New behaviour has a test; count did not drop.

### Frontend (`ai/rules/frontend.md`)
- [ ] No value computed in the browser.
- [ ] Every new element handles stale, NCD and invalid.
- [ ] No framework, no CDN, colour tokens reused.
- [ ] Checked in a browser, or stated that it was not.

### Contracts (`ai/rules/integrator.md`)
- [ ] All producers and consumers changed in the same commit.
- [ ] Golden vectors regenerated, not hand-edited.

Report findings as `path:line: problem. fix.`, most severe first. Fix or get the
user's decision before committing.

## 3. Commit

- Branch: stay on the current feature branch. Never commit to `sandbox` directly
  unless the user asks.
- Stage explicit paths. Never `git add -A` or `git add .`.
- Message: one imperative sentence, capitalised, no prefix, no trailing period,
  about 50–70 characters. Add a body only when the *why* is not obvious. Examples
  from history:
  - `Read the gamepad over HID; WinMM kept as fallback`
  - `Fix startup race and pad reader robustness`
- Keep the git identity already configured. Do not change it.

```bash
git add <paths>
git commit -m "<message>"
git log --oneline -1
```

## 4. Push (only when asked)

```bash
git push -u origin <branch>
```

If git asks for credentials and cannot prompt, tell the user to run the push in
their own terminal.
