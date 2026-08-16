# The Worker

One Worker serves everything:

| Path | Served by |
|---|---|
| `/api/auth` | `worker/src/index.js` — PIN check, JWT minting |
| everything else | the built React app, straight from Cloudflare's edge |

Same origin, so there is no CORS in production and no second hosting provider.
Config lives in `wrangler.toml` at the **repo root**, not here — that's what
lets Cloudflare's build settings use root directory `/`.

## Cloudflare build settings

These match what's already configured:

| Setting | Value |
|---|---|
| Root directory | `/` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Production branch | `main` |

Push to `main` and Cloudflare builds the React app into `dist/`, then deploys
the Worker with those assets attached.

## Secrets — set these once

Dashboard → the Worker → **Settings → Variables and Secrets → Add → Secret**.
They persist across deploys; a push never overwrites them.

| Name | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | same page → `service_role` |
| `JWT_SECRET` | same page → JWT Secret |

Until all three exist, `/api/auth` returns 500 and nobody can sign in.

## Check it

```bash
curl -X POST https://backbar.darko-savevski.workers.dev/api/auth \
  -H "Content-Type: application/json" \
  -d '{"action":"pair","barCode":"4821"}'
```

- `{"barId":"...","barName":"..."}` — working
- `No bar uses that code` — Worker and database are talking; you just haven't
  created that bar yet
- `Could not reach the server` (500) — a secret is missing or wrong

Live logs: `npx wrangler tail`.

## The one that costs an hour

`JWT_SECRET` must be **Backbar's** Supabase JWT secret, not Elaks'. A token
signed with the wrong secret is rejected by PostgREST with a vague 401 that
looks like a dozen other problems. Check this first if login mysteriously fails.

## Local development

```bash
npx wrangler dev
```

Serves the app and `/api/auth` together on one port, exactly like production.

Or run Vite alone with `npm run dev` for fast hot reload — then set
`VITE_AUTH_URL` in `.env.local` to the deployed Worker, since :5173 can't serve
the API itself.
