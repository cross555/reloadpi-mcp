# reloadpi-mcp

MCP server for the [Reloadpi](https://reloadpi.com) digital goods catalog.

Exposes **13 tools** across eSIMs, mobile top-ups, and gift vouchers — all paid automatically
in USDC on Base via the [x402 protocol](https://x402.org). No account needed. Agents bring their own funded wallet.

**Live endpoint:** `https://mcp.reloadpi.com/mcp`

---

## Tools

| Category | Tools |
|----------|-------|
| Vouchers | `browse_voucher_offers` `get_voucher_offer` `get_voucher_filters` `purchase_voucher` |
| Top-ups  | `browse_topup_offers` `get_topup_offer` `purchase_topup` |
| eSIMs    | `browse_esim_offers` `get_esim_offer` `purchase_esim` |
| Orders   | `get_order` `recover_order_by_txhash` `claim_refund` |

Browse and order-polling tools are free. Purchase tools trigger an x402 USDC payment automatically.

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
      "args": ["-y", "reloadpi-mcp"],
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
EVM_PRIVATE_KEY=0x...   # funded Base wallet — agent pays USDC for purchases
RELOADPI_API_BASE=https://api.reloadpi.com/api/catalog   # optional override
PORT=3100                                                  # optional
```

You need USDC on Base mainnet. Get it at [Coinbase](https://coinbase.com) or bridge from another chain.

> **No account required.** Your wallet is your identity. Payments settle on-chain directly — Reloadpi never holds your funds.

---

## Payment model

- **Browse / polling tools** — free, no payment
- **Purchase tools** — x402 micropayment in USDC deducted automatically per call
- Refunds: eSIM orders refunded on `FULFILLMENT_FAILED`; vouchers and topups non-refundable once delivered

---

## Transport

Streamable HTTP (`POST /mcp`) — compatible with Claude Desktop 2025/2026 and any MCP client
supporting the streamable HTTP transport spec.

---

## Built with

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- [`@x402/axios`](https://github.com/x402-org/x402) — x402 payment middleware
- [viem](https://viem.sh) — EVM wallet signing