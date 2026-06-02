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

## 1. Clone the repo into the canonical location
The project must live at **`C:\Users\bdstd\Documents\projects\command-center`** (docs and
config assume this path).

```powershell
cd C:\Users\bdstd\Documents\projects
git clone https://github.com/ahmedmagdy1987/command-center.git
```

## 2. Per-machine git TLS fix — REQUIRED after a wipe (clone/fetch/push fail without it)
After a wipe the Windows root certificate store can't verify GitHub's TLS cert, so git's
default **schannel** backend fails with a cert error. Switch git to the **openssl** backend
and point it at the **CA bundle that ships with Git for Windows**:

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
- If the clone in step 1 already failed with a cert error, run this fix first, then retry.
- Confirm: `git config --global --get http.sslBackend` → `openssl`.

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

Get the anon key one of two ways:
- **Supabase MCP** (after step 6 auth): call `get_publishable_keys` — it returns the legacy
  `anon` JWT (use that for `VITE_SUPABASE_ANON_KEY`) plus a modern `sb_publishable_…` key
  (which also works). `get_project_url` returns the URL. *(Note: there is no literal
  `get_anon_key` tool — `get_publishable_keys` is the one that returns the anon key.)*
- **Dashboard** — Supabase → project `nqlzjuxqgajeoypyzlnv` → Settings → API.

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
always push your work — a wipe takes anything uncommitted/unpushed with it.

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
