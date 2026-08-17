# Fiscal bridge — the contract

Backbar runs in a browser. A browser cannot drive a serial or USB fiscal
printer, and under Macedonian law it should not be the fiscal component
anyway — the receipt has to come off an approved device, driven by software
holding a UJP licence.

So there is a small **bridge**: a program running on one machine in the bar
(the till PC, a mini PC, or the printer's own network interface). Backbar posts
a closed bill to it over the local network; the bridge drives the printer and
reports back what the printer said.

```
   tablet ──── /api/auth, data ────► Cloudflare / Supabase
      │
      └──── POST /fiscal/print ────► bridge (LAN) ────► approved fiscal printer
                                        │
                                        └──► UJP (GPRS/network, by the printer)
```

Two properties matter more than anything else here:

- **The bridge is on the local network.** If the internet is down but the bar's
  LAN is up, receipts still print. That's the common failure and the important
  one.
- **Backbar never composes fiscal data itself.** It sends the bill; the licensed
  side decides receipt format, numbering, and what goes to UJP.

## Who writes it

Whoever holds the licence. Ask a Macedonian fiscal equipment manufacturer to
implement these four endpoints against their existing driver — it is a small
job for them because they already talk to the printer and to UJP. This document
exists so that conversation takes ten minutes.

If you later licence Backbar as an ИАСУ yourself, you write the bridge, and
nothing above it changes.

## Endpoints

Base URL is per bar, e.g. `http://192.168.1.50:8usb0`. Configure it per device.

### `GET /fiscal/status`

Is the printer usable right now? Called on load and before each print, so the
app can warn before a waiter takes an order it cannot legally close.

```json
{
  "ok": true,
  "device": "FP-2000-1234567",
  "paper": "ok",
  "lastReceiptNo": "0000418",
  "dayOpen": true,
  "message": null
}
```

`paper` is `ok` | `low` | `out`. `dayOpen` false means a Z report is due before
anything else can print.

### `POST /fiscal/print`

The body is exactly what `fiscal_payload(bill_id)` returns:

```json
{
  "billId": "8f2c…",
  "bar":   { "name": "Fjaka DOOEL", "taxId": "4080…", "device": "FP-2000-1234567", "currency": "MKD" },
  "table": "7",
  "staff": "Ana",
  "closedAt": "2026-08-17T21:14:03Z",
  "method": "cash",
  "discount": 0,
  "total": 1290.00,
  "vat": [
    { "rate": 18.0, "gross": 990.00, "net": 838.98, "vat": 151.02 },
    { "rate": 10.0, "gross": 300.00, "net": 272.73, "vat": 27.27 }
  ],
  "lines": [
    { "name": "Negroni", "qty": 3, "unitPrice": 330.00, "vatRate": 18.0, "lineTotal": 990.00 },
    { "name": "Espresso", "qty": 3, "unitPrice": 100.00, "vatRate": 10.0, "lineTotal": 300.00 }
  ]
}
```

On success:

```json
{ "ok": true, "receiptNo": "0000419", "device": "FP-2000-1234567", "printedAt": "2026-08-17T21:14:05Z" }
```

On failure:

```json
{ "ok": false, "error": "paper out", "retryable": true }
```

**`billId` is the idempotency key.** Backbar retries on a network failure, and
the same `billId` must never produce a second fiscal receipt. Keep a local
record of what you have printed and return the original `receiptNo` if it comes
again. This is the single most important requirement in this document — a
duplicated fiscal receipt is a real problem, and the network will make you
handle it.

`retryable: false` means the app stops retrying and flags the bill for the owner
instead of hammering a printer that will keep refusing.

### `POST /fiscal/void`

```json
{ "billId": "8f2c…", "receiptNo": "0000419", "reason": "wrong table" }
```

Issues the storno document (касова сметка за сторна трансакција). Returns
`{ "ok": true, "receiptNo": "0000420" }` — the storno gets its own number.

### `POST /fiscal/z-report`

Closes the business day on the device. Returns:

```json
{ "ok": true, "zNumber": "0231", "total": 48310.00, "device": "FP-2000-1234567" }
```

Backbar records this against `fiscal_day_reports` so the owner's own totals can
be checked against the device's.

## Security

The bridge sits on a LAN, which is not the same as safe — bar wifi usually has
guests on it.

- Bind to the LAN interface, never `0.0.0.0` on a public IP
- Require a shared token: `Authorization: Bearer <token>`, configured per bar
- Reject any origin except the app's
- HTTPS with a self-signed cert is awkward from a browser; the usual answer is
  to run the bridge on the same host as a small reverse proxy, or accept plain
  HTTP on a trusted VLAN. Discuss with whoever installs it.

## What Backbar does around this

- `bills.fiscal_status` moves `pending` → `sent`, or `failed` with the message
- `mark_bill_fiscalised()` stores the receipt number; it is idempotent too, so a
  duplicated callback cannot overwrite a number
- `fiscal_log` is append-only: what was sent, what came back, when
- Failed bills surface in the owner's Money tab — an unfiscalised paid bill is a
  compliance problem someone has to see, not a silent error

## Before any of this goes live

Backbar as it stands is not a licensed ИАСУ. The seam above is built so that
integration is wiring rather than a rebuild, but the licence has to come first.
Confirm with UJP's fiscalisation department whether your arrangement needs its
own дозвола, and get it in writing.
