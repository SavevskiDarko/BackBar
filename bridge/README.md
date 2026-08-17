# The fiscal bridge

A browser can't open a serial port — and even where it now can, one tablet would
own the printer and the rest of the floor couldn't print. So one machine in the
bar holds the printer and speaks HTTP to everyone else.

```
tablets ──HTTP over the bar's wifi──► this box ──RS-232──► fiscal printer
```

Because it sits on the LAN, receipts still print when the internet is down.
That's the failure that actually happens, and the one that matters: a cash sale
needs its receipt at the moment of payment.

## Try it with no printer at all

```bash
cd bridge
npm install
npm run simulate
```

It prints receipts to the terminal and returns plausible receipt numbers. Then
in the app: **Money → Fiscal printer**, set the address to
`http://<this-machine's-LAN-ip>:8377`, turn it on, save, and close a bill. A
receipt appears in the terminal and the bill gets a number.

Find the address with `hostname -I` (Linux/Mac) or `ipconfig` (Windows).
`localhost` will not work — the tablet is a different device.

## With a real printer

You need a USB-to-RS232 adapter unless the machine has a real serial port.

```bash
npm run ports                                   # what's connected
SERIAL_PATH=/dev/ttyUSB0 BAUD=9600 npm start
```

On Windows that's `SERIAL_PATH=COM3`. The baud rate is in the printer's manual;
9600 and 115200 cover most.

| Variable | Default | |
|---|---|---|
| `PORT` | 8377 | HTTP port |
| `SERIAL_PATH` | /dev/ttyUSB0 | the printer |
| `BAUD` | 9600 | from the manual |
| `BRIDGE_TOKEN` | *(none)* | set this on real bar wifi |
| `SIMULATE` | | `1` for no printer |

## What still has to be replaced

`writeToPrinter()` sends plain text. A real Macedonian fiscal printer speaks its
manufacturer's protocol through a crypto module, and issuing an actual fiscal
receipt requires a UJP licence for the software.

Everything around that function is already right — the endpoints, the
idempotency, the receipt data — so a licensed manufacturer swaps in their driver
and nothing else changes. `docs/fiscal-bridge.md` is the document to send them.

Until then this prints something that looks like a receipt and is not one.

## The rule that will bite you

`billId` is the idempotency key. The tablet retries on a dropped connection, and
a connection can die *after* the printer has printed. `printed.json` records what
has been done, survives a restart, and makes a repeat request return the original
receipt number rather than printing a second one. A duplicated fiscal receipt is
a real problem — don't remove that file or that check.
