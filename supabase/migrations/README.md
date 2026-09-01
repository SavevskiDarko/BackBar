# Migrations

These are the same 25 SQL files that used to sit loose in `supabase/`, renamed
so that the order they must run in is written down rather than remembered.
Nothing inside any file changed — only its name.

The order came from the files themselves. Most carry a `part N` line in their
header ("BACKBAR — part 7: PIN recovery · Run AFTER the previous six"), which is
the author's own numbering; the fixes, which carry no number, are placed by the
date they entered git and by what they repair. Two judgement calls are recorded
at the bottom of this file.

## The point of the rename

`schema.sql` and `rpc.sql` are safe to identify by name. The other 23 are not:
sixteen of them arrived in a single upload, so git cannot tell you what ran
before what, and `fix-cash.sql` next to `fix-transfer.sql` next to
`split-fix.sql` says nothing about which repairs which. Rebuilding a Supabase
project from that meant reading all 25 files and reconstructing the order by
hand. Now `ls` answers it.

## Bringing up a new project

```bash
supabase link --project-ref <ref>
supabase db push
```

Or paste each file into the SQL editor in filename order.

## The project that is already live

**Production already has every one of these applied.** They were run by hand,
before there was a migrations table, so the CLI has no record of them and
`supabase db push` would try to run all 25 again.

Most are written to survive that — `create or replace function`,
`add column if not exists`, `drop policy if exists` — but not all of them are,
and a re-run is not worth risking against a bar's live takings. Tell the CLI
they are already in place instead:

```bash
supabase migration list                        # see what it thinks is missing
supabase migration repair --status applied 20260822082401   # ... and so on
```

Do that once, for every version below. After that `db push` only carries new
migrations.

## The order

| # | File | Was |
|---|---|---|
| 1 | `20260822082401_schema.sql` | `schema.sql` |
| 2 | `20260822082402_rpc.sql` | `rpc.sql` |
| 3 | `20260822082403_offline_safe_writes.sql` | `offline.sql` |
| 4 | `20260822082404_fiscal_readiness.sql` | `fiscal.sql` |
| 5 | `20260822082405_owner_reporting.sql` | `reports.sql` |
| 6 | `20260822082406_per_bar_branding.sql` | `branding.sql` |
| 7 | `20260822082407_pin_recovery.sql` | `recovery.sql` |
| 8 | `20260822082408_lockout_guards.sql` | `guards.sql` |
| 9 | `20260822082409_delete_bar.sql` | `delete-bar.sql` |
| 10 | `20260822082410_fix_owner_guard_on_delete.sql` | `fix-owner-guard.sql` |
| 11 | `20260822082411_fix_stamp_trigger_on_delete.sql` | `fix-stamp-trigger.sql` |
| 12 | `20260822082412_reset_trading.sql` | `reset-trading.sql` |
| 13 | `20260822082413_reset_bar_data.sql` | `reset-data.sql` |
| 14 | `20260822082414_fiscal_v2.sql` | `fiscal-v2.sql` |
| 15 | `20260822082415_own_pin.sql` | `own-pin.sql` |
| 16 | `20260822082416_split_bill.sql` | `split-bill.sql` |
| 17 | `20260822102519_fix_split_line_matching.sql` | `split-fix.sql` |
| 18 | `20260823084041_fix_cash_split_reporting.sql` | `fix-cash.sql` |
| 19 | `20260823140339_language.sql` | `language.sql` |
| 20 | `20260823140340_voids.sql` | `voids.sql` |
| 21 | `20260825063304_stock.sql` | `stock.sql` |
| 22 | `20260827122344_shifts.sql` | `shifts.sql` |
| 23 | `20260828070315_fix_transfer_ambiguous_column.sql` | `fix-transfer.sql` |
| 24 | `20260829170139_reorder.sql` | `reorder.sql` |
| 25 | `20260829210646_bottled.sql` | `bottled.sql` |

Timestamps from 17 onward are the real dates those files entered git. The first
sixteen all arrived in one commit, so they share that commit's minute and are
separated by a second each to hold the `part N` order.

## Two things that were ambiguous

**`reset-trading.sql` and `reset-data.sql` are both labelled "part 10."** They
are two passes at the same feature and both define `bar_reset_preview`, so
whichever runs second wins. `reset-data.sql` is placed second because the app
calls `reset_bar_data`, which only it defines. Worth knowing: the two versions
of `bar_reset_preview` do not return the same fields — `reset-data`'s has
`firstBill`, `lastBill` and `simulatedReceipts`, `reset-trading`'s has
`openOrders`, and `ResetDialog` in `App.jsx` reads from both sets. Under this
order the dialog's `openOrders` is always undefined. That is the existing
behaviour of the live database, not something the rename introduced, but it is
a loose end worth closing.

**The two `fix-*-on-delete` files repair things that deleting a bar trips
over**, so they must follow `delete_bar` (9). Both are
`create or replace function`, so their exact position after that point does not
matter.

## Adding one

```bash
supabase migration new what_it_does
```

Write it, run it against a branch or a local `supabase start`, then `db push`.
Don't edit a migration that has already run anywhere — add another.
