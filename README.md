# PowerApp

An installable web app for [PowerDesk](https://github.com/PawelW2201/PowerDesk), a personal project for learning
how European power markets work on public data.

- **Today** shows the day-ahead brief PowerDesk builds through the day: base, peak and off-peak prices for 13
  bidding zones, and for any of them the price curve against residual load (load minus wind and solar, from the
  TSOs' day-ahead forecasts on ENTSO-E) and where the day sits on the last two weeks' supply curve. Tap a zone for
  its own sheet, with the cross-check between ENTSO-E and Energy-Charts prices.
- **Products** works on its own, without a token: delivery hours for any standard product (Cal27, Q1-27, Nov26,
  Wk45, WE, BOM, DA…), base, peak and off-peak, clock changes included, and what a price move is worth on a
  position. Polish products follow TGE's PEAK5 (07–22 on working days); the rest follow EEX (Mon–Fri 08–20).
- **Curve** builds an hourly price forward curve from the base and peak quotes you type for months, quarters,
  seasons and years: it checks they fit together, shows the implied products, shapes every hour from the zone's
  history, and prices profiles against it (solar and wind capture, a battery's intrinsic value, any block of hours).
  Below, how the shape of a day and capture rates changed from 2019 on.
- **RfQ** prices a deal against that curve: a pay-as-produced solar or wind PPA as a bridge from the base price to
  an offer in €/MWh, or a battery toll from intrinsic value to an offer in €/MW a year. Each history year is a
  scenario, so you also see how much the deal moves from one kind of year to another. The same battery can carry a
  revenue floor instead: a put on each year's revenue, priced with Black-76, with the fee, the chance it pays, and
  the share of upside that would pay for it instead (a zero-cost collar).
- **Options** works on its own too: options on a future (Black-76 or Bachelier, greeks, implied vol, value against
  the future), an average-price option on a delivery month priced both as a European on the month future and
  as an Asian on the daily fixings (moment matching and Monte Carlo, on a two-factor forward model), and a
  clean spark spread option (Kirk, with a Monte Carlo check).

This repository holds **only the app's code**. It contains no data: when you open Today, the app reads
`summary.json` from the `dashboard-data` branch of your private PowerDesk repository, and Curve and RfQ read the
history statistics and hourly history from its `data` branch, straight from GitHub's API, with a read-only token
you paste once per device. Some of that data is licensed for private use only, which is why it never lives here.
The quotes you type stay on your device.

## Set up

1. Open the app's GitHub Pages address on your computer or phone.
2. On Today, tap **Create a read-only token**. On GitHub, set *Repository access* to *Only select repositories*
   and pick PowerDesk. *Contents: Read-only* is already filled in. Generate the token and copy it.
3. Paste it and tap **Connect**.

To install it: in Chrome or Edge use *Install app*; on Android use *Add to Home screen*; on iPhone use Safari's
*Share → Add to Home Screen*. Settings has a setup link and QR code to connect another device without a new token.

## Privacy

- The token stays in this browser's storage and is only ever sent to `api.github.com`.
- The last brief is kept on the device so the app opens offline. Settings → *Disconnect this device* removes both.
- Phone pushes come from PowerDesk's workflow through [ntfy](https://ntfy.sh) once its `NTFY_TOPIC` secret exists.

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell and styles |
| `app.js` | The app: connecting, Today, zone sheets, Products, Curve, RfQ, Options, settings |
| `calendar.js` | Delivery hours of standard products; a port of PowerDesk's `powerdesk/products.py` |
| `options.js` | Option pricing; a port of PowerDesk's `powerdesk/options.py` |
| `curve.js` | The forward curve; a port of PowerDesk's `powerdesk/curve.py` |
| `rfq.js` | PPA and toll pricing against the curve; a port of PowerDesk's `powerdesk/rfq.py` |
| `charts.js` | Small charts: step lines for prices and load, a scatter for price against residual load, lines for option values and curves, and the bridge (waterfall) behind an offer |
| `sw.js` | Offline copy of the app's own files (never touches GitHub data requests) |
| `manifest.webmanifest`, `icons/` | Install metadata and icons |
| `fonts/` | Barlow and Barlow Semi Condensed, SIL Open Font License 1.1 (`fonts/OFL-Barlow.txt`) |
| `vendor/qrcode.mjs` | QR Code Generator for JavaScript by Kazuhiko Arase, MIT license (header in the file) |
| `tests/` | Checks `calendar.js`, `options.js`, `curve.js` and `rfq.js` against fixtures made from the Python reference, on synthetic data only: `npm test` |

No build step: GitHub Pages serves these files as they are.
