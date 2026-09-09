# reloadpi-mcp

MCP server for the [Reloadpi](https://reloadpi.com) digital goods catalog.

Exposes tools across eSIMs, mobile top-ups, and gift vouchers. **Browsing and order-polling are
free.** Purchasing settles in USDC on Base via the [x402 protocol](https://x402.org) from **your
own wallet** — so purchase tools are only available when you self-host with a key (see below).
No account needed.

**Live endpoint (browse-only):** `https://mcp.reloadpi.com/mcp`

---

## Tools

| Category | Tools |
|----------|-------|
| Vouchers | `browse_voucher_offers` `get_voucher_offer` `get_voucher_filters` `purchase_voucher` |
| Top-ups  | `browse_topup_offers` `get_topup_offer` `purchase_topup` |
| eSIMs    | `browse_esim_offers` `get_esim_offer` `purchase_esim` |
| Orders   | `get_order` `recover_order_by_txhash` `claim_refund` |

Browse, filter and order-polling tools are **free** and always available (they use the free `/ai`
API — no wallet). `get_*_offer` (paid detail) and `purchase_*` appear **only when you self-host
with `EVM_PRIVATE_KEY`** — they settle x402 payments from your own wallet.

> ⚠️ **Never set `EVM_PRIVATE_KEY` on a public deployment.** The server signs from whatever key it
> holds, for anyone who connects. Public hosting (like `mcp.reloadpi.com`) must run **without** a
> key — browse-only. Keys belong only on a machine you control.

### Finding an eSIM that covers a country

`browse_esim_offers` keeps *single-country plans* and *multi-country regional bundles* apart, because
a bundle's region tag says how the provider filed it, not what it covers — the "Asia" bundle covers
AU, NZ and UZ but not Japan, India or China, which only "Global" bundles reach.

| Filter | Returns |
|--------|---------|
| `country` | Single-country plans for one country (ISO-2, e.g. `JP`) |
| `regions` | Single-country plans grouped by area. The tags partition and do not nest: Thailand is `Southeast Asia`, India is `South Asia`, Japan is `Asia` |
| `regional_region` | Multi-country bundles tagged for an area |
| `covers_country` | Multi-country bundles that **actually** cover a country |
| `covers_countries` | One bundle covering **every** country in a list — `["BR","AR","CL"]` for a multi-stop trip |

When someone names a country, reach for `country` or `covers_country`, never `regional_region`.
Coverage is matched against each bundle's real roaming list by the platform API, so results are paged
server-side and `total` is the true match count. If no single bundle covers everything asked for, the
reply lists the closest bundles and what each one misses.

---

## Connecting

### Browse only (no purchases)

Just add the hosted URL — no setup needed:

```json
{
  "mcpServers": {
    "reloadpi": {
      "url": "https://mcp.reloadpi.com/mcp"
    }
  }
}
```

### With purchases via npx (recommended)

No cloning needed. Add to your MCP config and set your wallet key:

```json
{
  "mcpServers": {
    "reloadpi": {
      "command": "npx",
      "args": ["-y", "reloadpi-mcp", "--stdio"],
      "env": {
        "EVM_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

npx downloads and starts the server automatically. Requires Node.js 18+.

### With purchases via git clone

```bash
git clone https://github.com/cross555/reloadpi-mcp
cd reloadpi-mcp
npm install
cp .env.example .env   # add your EVM_PRIVATE_KEY
npm start
```

Then update your MCP config:

```json
{
  "mcpServers": {
    "reloadpi": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### Environment variables

```env
EVM_PRIVATE_KEY=0x...   # SELF-HOST ONLY — funded Base wallet; enables purchase tools.
                        # NEVER set on a public host. Unset = browse-only.
RELOADPI_API_BASE=https://api.reloadpi.com/api/catalog   # optional — paid routes
RELOADPI_AI_BASE=https://api.reloadpi.com/ai             # optional — free browse API
PORT=3100                                                # optional
MCP_AUTH_TOKEN=                                          # optional — Bearer gate on /mcp
```

`RELOADPI_AI_BASE` must point at an API that supports the `covers` coverage filter (`api.reloadpi.com` does) — without it, coverage searches come back unfiltered.

You need USDC on Base mainnet. Get it at [Coinbase](https://coinbase.com) or bridge from another chain.

> **No account required.** Your wallet is your identity. Payments settle on-chain directly — Reloadpi never holds your funds.

---

## Payment model

- **Browse / polling tools** — free, no payment
- **Purchase tools** — x402 micropayment in USDC deducted automatically per call
- Refunds: eSIM orders and carrier-rejected topups auto-refund on `FULFILLMENT_FAILED`/`EXPIRED` (auto_on_fail, ~24h window); voucher codes and delivered airtime are non-refundable

---

## Transport

Streamable HTTP (`POST /mcp`) — compatible with Claude Desktop 2025/2026 and any MCP client
supporting the streamable HTTP transport spec.

---

## Built with

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- [`@x402/axios`](https://github.com/x402-org/x402) — x402 payment middleware
- [viem](https://viem.sh) — EVM wallet signing