# Staging cost sheet (S2.10)

Computed from the measured Fly probe artifacts of run
[41792947703](https://github.com/haseeb099/fizot/actions/runs/41792947703)
(`artifacts/s2-10/awake-*.json`, `asleep-*.json`). Regenerate the table with:

```bash
node --experimental-strip-types scripts/fizot/cost-sheet.mjs
```

## Measured (from the green staging probe)

| Field | Awake probe | Asleep probe |
| --- | ---: | ---: |
| Machine-seconds | **26.541** | **16.101** |
| Volume GB | **10** | **10** |
| Machine state at sample end | `started` | `started` |
| App | `fizot-cm-6302406165974b8f` | same |
| Machine guest (from Admin contract) | `shared-cpu-1x`, **2 GB** RAM | same |
| Egress bytes | **null** (not on Machines list API) | **null** |

The asleep file is a second wall-clock sample after a sleep attempt that returned
HTTP 409; the machine was still `started`. Do **not** treat those 16.101 seconds
as proven stopped-machine billing.

Probe sample windows confirm the machine was billable while started. They are
**not** the monthly awake durations used in the profiles below.

## Fly unit prices used (published)

Source: [Fly.io Resource Pricing](https://fly.io/docs/about/pricing/) — read
**2026-11-04**. Machine list prices on that page are for `iad` / `ewr` (lowest
regions). Staging used region `lhr`; a regional uplift may apply and is called
out as an assumption.

| Unit | Price | How applied here |
| --- | ---: | --- |
| `shared-cpu-1x` 1 GB (started) | $6.70 / 30-day month | Base preset |
| Additional RAM | $6.00 / GB / month | +1 GB → **2 GB** total |
| **⇒ `shared-cpu-1x` 2 GB always-on** | **$12.70 / month** | $6.70 + $6.00 |
| Volume | $0.15 / GB / month | × 10 GB = $1.50 |
| Stopped Machine rootfs | $0.15 / GB / month | Assumed rootfs size only |
| Outbound egress (NA / Europe) | $0.02 / GB | Assumed GB/month only |
| Shared IPv4 + IPv6 | $0 | Free on Fly |

Per-second machine rate used in arithmetic: `$12.70 / (30 × 86400)` ≈
`$0.00000490` / sec.

## Assumed (not measured)

| Assumption | Value | Why |
| --- | --- | --- |
| Egress | **5 GB / customer / month** @ $0.02/GB = **$0.10** | `egressBytes` is null from the Machines API; stated figure only |
| Stopped rootfs size | **3 GB** | Image size was not measured on the probe |
| Billing month | 30 days | Matches Fly's published “per month” examples |
| USD/GBP | 1.30 | Same FX as the plan floor formula |
| Regional rate | iad/ewr list | Staging was `lhr`; treat list as baseline |
| Monthly awake hours | 24 / 8 / 1 | Customer usage profiles, not probe durations |

## Cost per customer per month (Fly infra only)

| Profile | Awake | Machine (running) | Rootfs (stopped) | Volume | Egress (assumed) | **Total USD** | **≈ GBP** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Always on | 24 h/day | $12.7000 | $0.0000 | $1.5000 | $0.1000 | **$14.3000** | **£11.0000** |
| 8 h/day awake | 8 h/day | $4.2333 | $0.3000 | $1.5000 | $0.1000 | **$6.1333** | **£4.7179** |
| Mostly asleep | 1 h/day | $0.5292 | $0.4313 | $1.5000 | $0.1000 | **$2.5605** | **£1.9696** |

Worst case for margin tests is **always on ($14.30 / month)**.

Plan floor (S2.10 formula, **excluding AI**):

`price_GBP = (cost_USD / 1.30 + 0.20) / (1 - 0.40 - 0.022)`

At always-on Fly total $14.30 → **£19.38** (before deciding Personal list price).

## AI cost (separate; proxy pass-through)

| Item | Status |
| --- | --- |
| Measured model USD / customer / month | **Not measured** on this Fly probe |
| Assumed markup on proxy pass-through | **0** (no markup yet) |
| Where numbers will come from | Fizot proxy ledger (S2.9 / P4.4) |

AI spend is listed separately so Personal / Team list prices can be set later
without mixing model tokens into the Fly infra rows above. Until ledger
samples exist, treat AI cost as **TBD pass-through**.

## Measured vs assumed (summary)

- **Measured:** awake/asleep machine-seconds samples, volume size (10 GB),
  machine guest shape (shared-cpu-1x 2 GB), probe source run.
- **From Fly published pricing (cited):** machine $/month, volume $/GB-month,
  stopped rootfs $/GB-month, egress $/GB.
- **Assumed:** egress GB/month, rootfs GB, usage profiles (24/8/1 h), FX,
  iad baseline for an `lhr` staging app.
- **Not measured / null:** egress bytes, actual stopped billing, AI tokens.
