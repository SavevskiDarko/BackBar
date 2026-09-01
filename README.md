# Backbar

Floor plans, table orders and profit tracking for bars — sold to bar owners on a
monthly subscription.

Three seats:

| Who | Sees |
|---|---|
| **Platform** (you) | Every bar, subscription status, payments, MRR |
| **Bar owner** (your client) | Their floor, floor designer, price list, money, their team |
| **Waiter** | The floor and the order pad. No prices paid, no profit, no reports |

---

## 1. Get it on GitHub

From this folder:

```bash
git init
git add .
git commit -m "Backbar: floor, orders, subscriptions"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/backbar.git
git push -u origin main
```

Make the repo **private**. It contains your pricing model and, until you finish
step 3, seeded demo PINs.

## 2. Deploy on every push

One Worker serves everything — the React app as static assets and the auth API
at `/api/auth`, same origin, no CORS, one bill. `.github/workflows/deploy.yml`
builds and ships it on every push to `main`, in about a minute.

It needs four repository secrets. **Settings → Secrets and variables → Actions
→ New repository secret**:

| Secret | Where it comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → template **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | the hex id in any dashboard URL, or `npx wrangler whoami` |
| `VITE_SUPABASE_URL` | same value as your `.env.local` |
| `VITE_SUPABASE_ANON_KEY` | same value as your `.env.local` |

The two `VITE_` ones are baked into the browser bundle and are public by design.
The `service_role` key is not among them and never should be — it lives only in
Worker secrets (`npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`).

Until all four exist the run fails at the build or the deploy step. Watch the
first one under the repo's **Actions** tab; after that, pushing is deploying.
Deploy by hand with `npm run deploy`, or from the Actions tab with **Run
workflow**, when you need to.

Add a custom domain under the Worker → Settings → Domains & Routes.

Don't add a second deploy path (Vercel, GitHub Pages, or Cloudflare's own
dashboard Git integration) alongside this one — the unused one silently rots and
then starts emailing you about failed builds.

## 3. Add the database

**You need one.** Right now everything lives in `localStorage` on a single
device, which breaks the product in four ways:

- The owner's phone and the waiter's tablet hold **different data**. Two waiters
  can't see each other's tables. In a real bar that's unusable within an hour.
- Clearing the browser wipes the day's takings. There is no backup.
- PINs are stored as plain text in the browser.
- **Your subscription enforcement is decoration.** A bar owner can open
  devtools, edit `suspended` to `false`, and keep using the app forever without
  paying. Every rule that protects your revenue has to sit on a server they
  don't control.

That last one is the reason to do this before you sign a second customer.

### Supabase

Postgres, auth, realtime and row-level security in one free tier. Realtime
matters here — it's what makes a table light up on every tablet at once.

1. Create a project at [supabase.com](https://supabase.com)
2. SQL Editor → paste **`supabase/schema.sql`** → Run
3. Project Settings → API → copy the URL and the `anon` key
4. `cp .env.example .env.local` and fill them in
5. In GitHub: Settings → Secrets and variables → Actions → add the same two
6. `npm i @supabase/supabase-js`

Then rewrite the `sget`/`sset` functions at the top of `src/App.jsx` to read and
write real tables instead of `localStorage`. That's the porting work, and it's
the bulk of the remaining effort — the schema is designed to mirror the shapes
the app already uses.

### What the schema guarantees

Read the comments in `schema.sql`; the short version:

- **`bar_is_live()`** gates every policy. An unpaid bar can't read or write
  anything, and no browser tampering changes that.
- **A trigger blocks owners from editing their own billing columns.** They can
  rename their bar. They cannot move their due date.
- **Waiters query a `menu_items` view that has no `cost_price` column.** They
  can't select a column that isn't there.
- **Waiters can INSERT bills but not SELECT them.** That's what makes "the
  waiter doesn't see how much the bar makes" true rather than merely hidden.
- **PINs are bcrypt hashed**, verified inside a `security definer` function.

### What's built

- **`supabase/schema.sql`** — tables and RLS
- **`supabase/rpc.sql`** — login throttling, server-side price stamping, atomic
  bill closing, platform billing calls
- **`worker/`** — the `backbar-auth` Cloudflare Worker: verifies PINs, mints scoped JWTs
- **`src/lib/`** — client, auth, data layer, realtime hook

See **PORTING.md** for wiring `App.jsx` onto it.

### Still to build

- **Stripe** for charging subscriptions instead of you pressing "Mark paid". The
  webhook calls `record_subscription_payment`. Stripe Billing handles the
  dunning emails when a card fails.
- **Delete the demo PIN panel** in `AuthScreen` before a real customer sees it.

## Local development

```bash
npm install
npm run dev
```

Opens on <http://localhost:5173>.

Demo access: bar codes `4821` `7390` `5514` `6602` · owner PIN `1111` ·
waiter PIN `1234` · platform `900900`.

All four bars deliberately reuse the same PINs — the device is paired to one bar
first, so PINs only ever need to be unique inside that bar. That's what keeps you
from running out of 4-digit codes at your 300th customer.

## Layout

```
src/App.jsx                     the whole UI
src/lib/supabase.js             client setup
src/lib/auth.js                 pairing, PIN login, platform login
src/lib/api.js                  every read and write
src/lib/useBarData.js           realtime floor
supabase/schema.sql             tables + RLS          (run first)
supabase/rpc.sql                functions             (run second)
worker/                         the Worker: PIN → JWT, serves the app
docs/fiscal-bridge.md           contract for a licensed fiscal printer
PORTING.md                      history of the Supabase port
```
