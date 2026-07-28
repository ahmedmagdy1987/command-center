# Corlyvo

A focused task & operations hub for small teams — tasks, projects, team chat, voice
notes, and file attachments in one shared workspace.

Live: <https://tasks.opscommandcenter.com>

> **Note on names.** The product is **Corlyvo**. The repository, the deployed domain,
> the Supabase project and the Stripe products still carry the previous name
> (`command-center` / `opscommandcenter.com`). Those are deploy and billing
> configuration, deliberately left alone — renaming them is a separate, coordinated
> change. See *Renaming the rest* below.

## Stack

- React 19 + react-router-dom 7, Vite 8, Tailwind 3, `lucide-react`
- `@supabase/supabase-js` v2 — auth, Postgres + RLS, Realtime, Storage
- No TypeScript, no test suite. Database correctness is proven by rolled-back SQL
  proofs in `supabase/tests/`.

```
npm install
npm run dev      # local dev server
npm run build    # production build
npm run lint     # eslint
npm run preview  # serve the built bundle
```

## Environment

`.env` is gitignored. Recreate it at the repo root with:

```
VITE_SUPABASE_URL=https://nqlzjuxqgajeoypyzlnv.supabase.co
VITE_SUPABASE_ANON_KEY=<anon/publishable key from the Supabase dashboard>
```

**Write it as UTF-8 without a BOM.** PowerShell's `Set-Content -Encoding utf8` adds
one, which makes `VITE_SUPABASE_URL` undefined at build time — the app then throws at
module top level, gets tree-shaken away, and `npm run build` exits 0 while emitting an
app-less bundle. A guard in `vite.config.js` now fails the build loudly instead.

## Design system

Colour, elevation and type live in **`src/styles/tokens.css`** and are exposed as
Tailwind utilities by `tailwind.config.js`. That file is the only place a colour is
decided.

- **Brand** Corlyvo Blue `#5B67F1` → `#747BFF`. Identity only — not the default colour
  of every button.
- **Accent** Flow Mint `#3DD6B3`. Sync/progress/success moments and the logo's end
  stop. Never a primary button.
- **Status stays semantic**: red = overdue/error, green = success/done,
  amber = warning/high priority, blue = informational. Do not repaint these with brand.
- **Gradient is rare** — logo mark, landing hero, upgrade modal, "Most popular" badge.
  Nothing else.
- **Type**: Geist in-product (dense UI, tabular figures), Manrope for the logo wordmark
  and marketing headings.

Light and dark are a real theme: the same semantic class renders correctly in both
because the variable underneath it changes. There is no `!important` override sheet —
if you find yourself writing one, the token is missing instead.

Four scopes exist and all four are load-bearing:

| Scope | Where | Why |
|---|---|---|
| `:root` | default | the dark theme |
| `[data-theme="light"]` | stamped on `<html>` | the light theme |
| `[data-surface="dark"]` | pre-app funnel roots | opts OUT of theming — `data-theme` persists on `<html>` after sign-out, so marketing pages would otherwise half-flip |
| `[data-surface="inverted"]` | Private / My Tasks heroes | dark islands in *both* themes |

The text tokens are pinned to a measured contrast ladder
(primary 15:1 · secondary 7.5:1 · muted 5.5:1 · faint 4.5:1). Re-measure before
softening any of them — `text-faint` carries form labels.

## Database

`supabase/migrations/` is the source of truth for schema, RLS, triggers and grants.
Read it before changing anything; the live database should match it exactly.

Authorization is **per-workspace** via `workspace_members.role`, a four-rung ladder
(owner > admin > member > guest) evaluated by `private.workspace_role_rank()`. The
global `members.role` column is vestigial — never read it for authorization.

RLS is the gate, not the app filter. Supabase auto-enables RLS on new tables, so a new
table with no policy is invisible to clients; always add policies.

## Renaming the rest

These carry the old name and are **not** changed by the in-app rebrand, because each
one touches deploy or billing configuration:

- GitHub repository `command-center`, and `name` in `package.json`
- The Vercel project and the `opscommandcenter.com` domain
- The Supabase project name, and the sender name/templates on its auth emails
- Stripe product and price display names
- The workspace literally *named* "Command Center" — that is a user's data, not branding
- Dated audit documents in the repo root, which are historical records

## Further reading

- `CLAUDE.md` — orientation for anyone (or any agent) picking the project up
- `RESTORE.md` — rebuilding the local environment after a machine wipe
- `ROLES_AND_PERMISSIONS.md`, `NOTIFICATIONS_AND_ACTIVITY.md`,
  `TASK_ATTACHMENTS_DESIGN.md` — subsystem designs
