# RESTORE — bring this machine back after a Deep Freeze wipe

> This machine runs **Deep Freeze**: every reboot resets the local disk to a frozen
> baseline. The Supabase DB and the GitHub repo are safe (off-machine); **local code,
> `.env`, installed tools, and per-machine git config are NOT.** After any wipe, walk
> this checklist top to bottom, in order — it's a checklist, not a re-derivation.
>
> Nothing here touches the database (the product's spine lives on Supabase). This is
> purely about rebuilding the *local* dev environment so you can run and commit again.

## 0. Reinstall the toolchain (only if the wipe removed it)
- **Git for Windows** — <https://git-scm.com/download/win>
- **Node.js** (LTS) — <https://nodejs.org> (provides `node` + `npm`)
- **Claude Code** — `npm install -g @anthropic-ai/claude-code` (or per current install docs)

Verify: `git --version`, `node --version`, `npm --version`, `claude --version`.

### 0.5. If git is missing entirely (no winget / choco / scoop on this machine)
A wipe can take git AND every package manager with it (verified on the 2026-07-06 restore: `git`,
`winget`, `choco`, `scoop` all absent; Node/npm survived), so the git-scm.com installer download may
be the only route — or skip installers entirely with portable **MinGit** (no admin, no installer):

```powershell
# 1. Download the latest MinGit zip from git-for-windows releases
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$rel = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -UseBasicParsing
$asset = $rel.assets | Where-Object { $_.name -like "MinGit-*-64-bit.zip" -and $_.name -notlike "*busybox*" } | Select-Object -First 1
Invoke-WebRequest $asset.browser_download_url -OutFile "$env:TEMP\MinGit.zip" -UseBasicParsing

# 2. Extract to the canonical portable location
Expand-Archive "$env:TEMP\MinGit.zip" -DestinationPath "C:\Users\bdstd\Tools\MinGit" -Force

# 3. Add it to the USER PATH (persists for new terminals; no admin needed)
$p = [Environment]::GetEnvironmentVariable("Path","User")
if ($p -notlike "*C:\Users\bdstd\Tools\MinGit\cmd*") {
  [Environment]::SetEnvironmentVariable("Path","$p;C:\Users\bdstd\Tools\MinGit\cmd","User")
}
$env:PATH = "C:\Users\bdstd\Tools\MinGit\cmd;$env:PATH"   # current session too
git --version
```

- Canonical location: **`C:\Users\bdstd\Tools\MinGit`** (`git.exe` at `…\MinGit\cmd\git.exe`).
- Terminals/tool sessions already open before the PATH change won't see it — prepend
  `$env:PATH = "C:\Users\bdstd\Tools\MinGit\cmd;$env:PATH"` in those.
- The 2026-07-06 restore used MinGit 2.55.0.2 this way; clone/fetch/push all worked on the
  default schannel backend with no TLS fix.

## 1. Clone the repo into the canonical location
The project must live at **`C:\Users\bdstd\Documents\projects\command-center`** (docs and
config assume this path).

```powershell
cd C:\Users\bdstd\Documents\projects
git clone https://github.com/ahmedmagdy1987/command-center.git
```

> **⚠ The `bdstd` profile is NOT guaranteed to exist after a wipe (hit for real 2026-08-24).** Deep
> Freeze can restore to a baseline where the active Windows account is a **different** user — that
> restore ran as `CCBoot`, `C:\Users\bdstd` did not exist, and creating it failed with
> `UnauthorizedAccessException` (a non-admin account cannot create another profile under
> `C:\Users`). Retrying with elevation does not help; this is an ACL boundary, not a tooling
> problem. **Check first, then use the profile you're actually running as:**
> ```powershell
> whoami                                    # who am I really?
> $root = "$env:USERPROFILE\Documents\projects"
> New-Item -ItemType Directory -Force $root | Out-Null
> git clone https://github.com/ahmedmagdy1987/command-center.git "$root\command-center"
> ```
> Nothing in the build actually depends on the `bdstd` spelling — `.env`, `vite.config.js` and
> `.mcp.json` are all repo-relative, and the 2026-08-24 restore built and linted clean from
> `C:\Users\CCBoot\Documents\projects\command-center`. Only the hardcoded paths **in these docs**
> assume it, so read every `C:\Users\bdstd\…` below as "the project root on *this* machine",
> including the MinGit location in §0.5 and the `.env` path in §5.

## 2. Per-machine git TLS fix — only if you actually hit a cert error (often NOT needed)
After a wipe the Windows root certificate store *can* fail to verify GitHub's TLS cert, making
git's default **schannel** backend error out on clone/fetch/push. But this often does **not**
happen — recent clones and pushes have worked on the default schannel backend with no fix
(e.g. the 2026-06-15 restore needed nothing here). **Only if you actually hit a cert error**,
switch git to the **openssl** backend and point it at the **CA bundle that ships with Git for
Windows**:

```powershell
git config --global http.sslBackend openssl
git config --global http.sslCAInfo "C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt"
```

- This does **NOT** disable SSL verification. GitHub's cert is still fully verified — just
  against Git's bundled CA bundle instead of the (post-wipe, incomplete) Windows store.
- **Verified path on this Git install:** `C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt`
  (the older `…/mingw64/ssl/certs/…` path no longer exists on this machine).
  If for any reason the file is missing, find it with
  `Get-ChildItem "C:\Program Files\Git" -Recurse -Filter ca-bundle.crt` and use that path.
- **Portable MinGit (§0.5) has no Program Files install** — its bundle lives at
  `C:/Users/bdstd/Tools/MinGit/mingw64/etc/ssl/certs/ca-bundle.crt` (path verified 2026-07-06);
  use that for `http.sslCAInfo` instead.
- If the clone in step 1 already failed with a cert error, run this fix first, then retry.
- Confirm: `git config --global --get http.sslBackend` → `openssl`.

## 2.5. Restore the git author identity — REQUIRED after a wipe (commits fail without it)
Deep Freeze also wipes the per-machine git identity, so the first `git commit` after a wipe
fails with **"Author identity unknown"** until you set it. Every commit in this repo's history
uses the same identity — restore it globally (like the TLS config above):

```powershell
git config --global user.name "Ahmed Magdy"
git config --global user.email "ahmedkassim17777@gmail.com"
```

- Confirm: `git config --global --get user.email` → `ahmedkassim17777@gmail.com`.
- Easy to miss: `npm install` + build + lint all pass and the restore *looks* finished, but
  you can't commit or push — which silently breaks the "always push after a wipe" rule below.

## 3. Install dependencies
```powershell
cd C:\Users\bdstd\Documents\projects\command-center
npm install
```

## 4. Launch Claude Code from INSIDE the project folder  ⚠️ has broken the MCP three times now
The repo ships a committed **`.mcp.json`** (the Supabase MCP server config). Claude Code only
loads it when you start `claude` with the command-center folder as the **working directory at
launch**. Starting from anywhere else (e.g. the home folder) silently omits the Supabase MCP
for the entire session — no error, just no `supabase` tools available.

**Checklist before launching:**
1. Open a **new** PowerShell / terminal window (don't reuse one left at `~` or elsewhere).
2. `cd C:\Users\bdstd\Documents\projects\command-center` — verify `Get-Location` shows the project.
3. Run `claude` from there.

After launching, confirm the MCP loaded: type `/mcp` in Claude Code — `supabase` must appear.
If it doesn't, `exit` and repeat from step 1; do NOT try to authenticate from the wrong folder.

```powershell
cd C:\Users\bdstd\Documents\projects\command-center
claude
```

## 5. Recreate the gitignored `.env`
`.env` is gitignored (so it's wiped and never committed). `src/lib/supabase.js` throws if
either var is missing. Recreate it at the repo root:

```
VITE_SUPABASE_URL=https://nqlzjuxqgajeoypyzlnv.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

> **⚠️ Write `.env` as UTF-8 WITHOUT a BOM (Windows footgun, root-caused 2026-07-24).** PowerShell 5.1's
> `Set-Content -Encoding utf8` prepends a UTF-8 BOM, which renames the first key to `‹BOM›VITE_SUPABASE_URL`,
> so `VITE_SUPABASE_URL` is **undefined at build time**. `src/lib/supabase.js` then throws at module top
> level and rolldown's dead-code elimination strips the **entire app**: `npm run build` exits 0 but emits a
> ~335 kB **app-less** `index-DrGuCE8m.js` instead of the real ~784 kB `index-DofwQkiD.js`. Write it
> BOM-less instead:

```powershell
$c = "VITE_SUPABASE_URL=https://nqlzjuxqgajeoypyzlnv.supabase.co`nVITE_SUPABASE_ANON_KEY=<key>`n"
[System.IO.File]::WriteAllText("C:\Users\bdstd\Documents\projects\command-center\.env", $c, (New-Object System.Text.UTF8Encoding($false)))
```

A **build guard in `vite.config.js`** now catches this whole class of bug: if `VITE_SUPABASE_URL` or
`VITE_SUPABASE_ANON_KEY` is missing (BOM, typo, absent file), `npm run build` **fails loudly** (non-zero
exit, no bundle) instead of silently shipping an empty app. It checks `process.env` too, so Vercel's
dashboard env vars satisfy it and production builds unchanged.

Get the anon key one of three ways:
- **Supabase MCP** (after step 6 auth): call `get_publishable_keys` — it returns the legacy
  `anon` JWT (use that for `VITE_SUPABASE_ANON_KEY`) plus a modern `sb_publishable_…` key
  (which also works). `get_project_url` returns the URL. *(Note: there is no literal
  `get_anon_key` tool — `get_publishable_keys` is the one that returns the anon key.)*
- **Dashboard** — Supabase → project `nqlzjuxqgajeoypyzlnv` → Settings → API.
- **Live-bundle fallback (no MCP, no dashboard access):** the key is public by design and baked
  into the production build. Fetch <https://tasks.opscommandcenter.com>, find the
  `/assets/index-*.js` it references, and pull the `sb_publishable_…` token out of it (the
  `sb_publishable_` prefix is the publishable key by definition — it *cannot* be a
  `service_role`/secret key, so no JWT-decode role check applies; a legacy `eyJ…` anon JWT would
  also work if the bundle carries one instead). Verify the recovered key: `npm run build` with
  the new `.env` should reproduce the exact deployed bundle filename/hash (2026-07-06 restore:
  local build == production `index-BOCUieEg.js`).

## 6. Authenticate the Supabase MCP
In Claude Code: `/mcp` → **supabase** → **Authenticate**. Required before any MCP DB call
(and for the MCP key-pull in step 5).

## 7. Orient
Read **`CLAUDE.md`** (repo root) — the full project guide: stack, DB model, the RLS engine,
phases done, conventions/landmines, behavior-preservation baselines, and the roadmap. Start
there before changing anything.

## 8. Run / verify
```powershell
npm run dev        # local dev server
npm run build      # production build
```
Production **auto-deploys from `main`** via Vercel (push to `main` = production deploy), so
always push your work — a wipe takes anything uncommitted/unpushed with it. **Before you reboot,
run the §9 safety check** — "I pushed it" is not evidence, and the check that *looks* like proof
isn't.

## 9. BEFORE YOU REBOOT — the pre-wipe safety check  🔴 THIS HAS ALREADY COST US A COMMIT

A reboot is irreversible: Deep Freeze discards every local object. So the check that says
"safe to wipe" has to be **evidence from the server**, not a local inference.

### ⛔ NEVER use this — it produced a false "safe to wipe" and lost `47a922d`
```powershell
git log --branches --not --remotes      # ⛔ BANNED as a pre-wipe gate
```
**Why it lies:** `--remotes` reads `refs/remotes/origin/*` — **local cache files**, not the
server. Those refs only move when *this clone* last fetched or believed a push succeeded, so the
command is really asking "does my local copy of the remote contain this?" A stale, hand-updated,
or optimistically-advanced tracking ref makes it print **nothing** — which reads as "everything is
pushed" — while the real remote has never seen the commit. It cannot detect the one failure mode
that matters, because the thing it trusts is the thing that's wrong.

**Reproduced empirically, not theorised (2026-08-24)** — on a throwaway branch with a local-only
commit: with an honest tracking ref the banned command *does* report it (so the demo isn't vacuous);
`git update-ref refs/remotes/origin/<branch> <sha>` — one stale ref, exactly what an
optimistically-advanced or hand-touched ref looks like — makes it print **nothing** while the commit
exists on no server anywhere. The §9 check below reported `UNSAFE … remote ABSENT` in both states.

**What it cost (2026-07-28/29):** local `main` carried **`47a922d`** — the new app-icon set plus
the interactive landing page. This command reported nothing unpushed, the machine was rebooted, and
`47a922d` ceased to exist; the actual `refs/heads/main` on GitHub was still **`c32461d`**, and
production was still serving a `c32461d` build. Recovery was possible **only** because the work
also existed on the pushed branch `feat/icon-and-landing` (`6ebfdcf`) — luck, not process.

### ✅ The authoritative check — ask the network, then compare
```powershell
cd C:\Users\bdstd\Documents\projects\command-center   # adjust per the §1 path note

# (a) Nothing uncommitted. ls-remote can NEVER see working-tree state, so check it separately.
#     --porcelain covers staged, unstaged AND untracked. It must print NOTHING.
git status --porcelain

# (b) Every local branch tip must exist on the REAL remote, verified over the wire.
$remote = @{}
git ls-remote --heads origin | ForEach-Object {
  $parts = $_ -split '\s+', 2
  $remote[$parts[1].Trim()] = $parts[0]
}
$unsafe = @()
foreach ($line in (git for-each-ref --format='%(refname:short) %(objectname)' refs/heads)) {
  $name, $sha = $line -split '\s+'
  $have = $remote["refs/heads/$name"]
  if ($have -ne $sha) {
    $shown = if ($have) { $have.Substring(0,7) } else { 'ABSENT ON REMOTE' }
    $unsafe += "  $name : local $($sha.Substring(0,7))  |  remote $shown"
  }
}
if ($unsafe) { "🔴 DO NOT REBOOT — these exist only on this disk:"; $unsafe } else { "✅ SAFE TO WIPE" }
```
- `git ls-remote` opens a **connection to GitHub** and reports what the server actually holds. That
  is the only trustworthy source. Note it takes **no** local refs into account — that's the point.
- The loop checks **every** local branch, not just the current one, and treats a branch the remote
  has never heard of as unsafe rather than skipping it.
- Run it **immediately before** the reboot. A check from an hour and three commits ago proves nothing.

### Cross-check a specific commit exists on GitHub (the direct question)
```powershell
$sha = "<full-or-short-sha>"
curl.exe -s -o NUL -w "%{http_code}`n" "https://api.github.com/repos/ahmedmagdy1987/command-center/commits/$sha"
```
**200** = GitHub has it (survives the wipe). **422** = no commit for that SHA — it exists nowhere
but this disk. *(422 is exactly what `47a922d` returns today.)*

### If the check says unsafe
Push it — a branch is fine, it does **not** have to be `main` (a push to `main` deploys to
production; a feature branch doesn't). Getting the objects onto the server is what matters:
```powershell
git push -u origin HEAD    # then re-run the check above until it prints SAFE TO WIPE
```

---

### Quick reference
| Thing | Value |
|------|-------|
| Project path | `C:\Users\bdstd\Documents\projects\command-center` |
| Repo | `https://github.com/ahmedmagdy1987/command-center.git` |
| Supabase project ref | `nqlzjuxqgajeoypyzlnv` |
| Supabase URL | `https://nqlzjuxqgajeoypyzlnv.supabase.co` |
| Live app | <https://tasks.opscommandcenter.com> |
| `.env` vars | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
