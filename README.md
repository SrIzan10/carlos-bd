# Carlos bday card

A FigJam-style birthday board where friends leave sticky notes, photos, and videos. It runs entirely on Cloudflare, as a gift to someone who works at Vercel.

| Piece | Cloudflare product |
| --- | --- |
| Framework | Astro (owned by Cloudflare) on Workers via `@astrojs/cloudflare` |
| Accounts | Better Auth on **D1** |
| Sessions | **Workers KV** (Better Auth secondary storage) |
| Bot check on sign-up/sign-in | **Turnstile** (Better Auth captcha plugin) |
| Auth rate limiting | **Workers Rate Limiting** binding |
| Realtime board, presence, storage | **Durable Objects** (SQLite + hibernatable WebSockets) |
| Photo and video uploads | **R2** |

The whole site sits behind a shared password (`SITE_PASSWORD`), checked in the Worker before anything else runs. Past that, anyone can view the board, and signing in lets you add, move, resize, recolor, and delete items. Click the title in the top-left corner for the "how this card is made" dialog.

## Develop

```sh
bun install
cp .dev.vars.example .dev.vars   # then set BETTER_AUTH_SECRET (openssl rand -hex 32) and SITE_PASSWORD
bun run db:migrate               # creates the Better Auth tables in local D1
bun run dev                      # http://localhost:4321
```

Local dev runs in `workerd` with local D1, KV, R2, and Durable Objects. The Turnstile keys in the repo are Cloudflare's always-pass test keys.

Board controls: `V` move, `H` or hold Space to pan, `S` sticky, `T` text, double-click or Enter to edit, Delete to remove, Ctrl/⌘ + wheel or pinch to zoom, `Shift+1` to fit. Drop or paste images and videos anywhere.

## Deploy

1. Create a Turnstile widget for your domain and put its site key in `TURNSTILE_SITE_KEY` in `wrangler.jsonc`.
2. Set the secrets:
   ```sh
   bunx wrangler secret put BETTER_AUTH_SECRET
   bunx wrangler secret put TURNSTILE_SECRET_KEY
   bunx wrangler secret put SITE_PASSWORD
   ```
3. `bun run deploy` builds, deploys (Wrangler provisions D1, KV, and R2 on the first deploy), and applies the D1 migrations.

The board itself lives in the `BoardRoom` Durable Object (`src/board/room.ts`), named `carlos-bday` in `src/worker.ts`.
