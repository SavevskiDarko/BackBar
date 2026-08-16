# Porting App.jsx onto Supabase

The backend is written. What's left is swapping the local state in `App.jsx` for
calls into `src/lib/`. This is the map.

## Set up first

```bash
npm i @supabase/supabase-js
supabase link --project-ref YOUR_REF
```

In the SQL editor, run in order:

1. `supabase/schema.sql`
2. `supabase/rpc.sql`

Then deploy the auth Worker:

```bash
cd worker && npm install
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put JWT_SECRET
npx wrangler deploy
```

Copy the resulting URL into `.env.local` as `VITE_AUTH_URL`.

Make yourself the platform admin — sign up once through Supabase Auth, then:

```sql
insert into platform_admins (user_id)
values ('<your auth.users id>');
```

## What replaces what

| Today in App.jsx | Becomes |
|---|---|
| `sget` / `sset` | delete both — `loadBar()` and the api functions |
| `useState` for venues/articles/orders | `useBarData(session)` |
| `resolvePin` | `signInStaff(pin)` from `lib/auth` |
| `pairDevice` | `pairDevice(barCode)` from `lib/auth` |
| platform PIN `900900` | `signInPlatform(email, password)` |
| `commitOrder` | `saveOrder(client, {...})` |
| `settleOrder` | `closeBill(client, {...})` |
| `settleUnpaid` | `settleBill(client, billId, method)` |
| `setArticles([...])` | `upsertArticle` / `deleteArticle` |
| `updateVenue` for floor edits | `upsertTable` / `moveTable` / `deleteTable` |
| `Team` save | `upsertStaff` |
| `AdminBars` handlers | `listBars`, `createBar`, `recordPayment`, `setSuspended`, `setPlan` |
| `subState()` in the browser | keep it for the *banner*, but access is decided by `bar_is_live()` in SQL |

## Order of work

1. **Auth first.** Replace the three handlers in `AuthScreen` with the `lib/auth`
   functions. Everything else needs a session to exist. Delete the demo PIN panel
   while you're in there.
2. **Read path.** Swap the load effect for `useBarData`. The mappers in `api.js`
   already return the camelCase shapes the components expect, so `FloorPlan`,
   `TableNode` and `Designer` should render untouched.
3. **Write path.** One handler at a time, wrapped in `mutate()` so the UI stays
   instant.
4. **Platform screen last.** It's the least used and the most self-contained.

## Two things that will bite you

**Table dragging.** `onMove` fires on every pointer move. Don't call `moveTable`
there — keep the drag in local state and write once on pointer up:

```jsx
onPointerUp={() => {
  if (drag.current) moveTable(client, drag.current.id, t.x, t.y);
  drag.current = null;
}}
```

**Cost is null for waiters.** `bar_snapshot` doesn't send `cost_price` to them,
so `article.cost` comes back `0`. That's deliberate — but it means any profit
maths in a shared component must stay behind `isOwner`, or waiters will see
zeroes that look like a bug rather than a permission boundary.

## Prove the permissions actually hold

Don't trust the UI. Log in as a waiter, open the console, and try:

```js
// Should return an empty array — waiters cannot read bills.
await client.from("bills").select("*");

// Should error — cost_price is not selectable by them.
await client.from("articles").select("cost_price");

// Should error — owners cannot move their own due date.
await client.from("bars").update({ next_due_at: "2030-01-01" }).eq("id", barId);
```

If any of those succeed, a policy is wrong. Fix it before you take money.

## Then Stripe

Replace the "Mark paid" button with real billing:

- Stripe Checkout for the first subscription, Stripe Billing for renewals
- A `stripe-webhook` Edge Function that calls `record_subscription_payment` on
  `invoice.paid`, and `set_bar_suspended` on `customer.subscription.deleted`
- Stripe chases failed cards for you, which is the part you don't want to do by
  hand at 200 customers

Keep the manual button too. You'll want it for the bar that pays you in cash.
