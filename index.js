// mcp.reloadpi.com — Reloadpi MCP Server
// Exposes Reloadpi catalog as MCP tools with automatic x402 payment.
// Agents bring their own EVM wallet via EVM_PRIVATE_KEY env var.
//
// Transport: Streamable HTTP — compatible with Claude Desktop 2025/2026
// Deploy as a separate service on Render (same account as api.reloadpi.com)

import "dotenv/config";
import axios from "axios";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { wrapAxiosWithPaymentFromConfig } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { randomUUID } from "crypto";

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE = process.env.RELOADPI_API_BASE ?? "https://api.reloadpi.com/api/catalog";
const PORT     = process.env.PORT ?? 3100;
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
if (!process.env.EVM_PRIVATE_KEY) {
  console.warn("⚠️  EVM_PRIVATE_KEY not set — browse tools work, purchase tools will fail.");
  console.warn("   Set it in your MCP config env or in a .env file to enable purchases.");
}

// ── x402 axios client ─────────────────────────────────────────────────────────

function buildHttpClient() {
  if (!process.env.EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY is required for purchase tools. Add it to your MCP config env block.");
  }
  const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
  return wrapAxiosWithPaymentFromConfig(axios.create({ baseURL: API_BASE }), {
    schemes: [
      {
        network: "eip155:8453",
        client: new ExactEvmScheme(account),
      },
    ],
  });
}

// ── MCP server factory (one per session) ─────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name:    "reloadpi",
    version: "1.0.0",
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // VOUCHER TOOLS
  // ─────────────────────────────────────────────────────────────────────────────

  server.tool(
    "browse_voucher_offers",
    "Search gift cards and vouchers from 5000+ brands across 150+ countries (Amazon, Google Play, Netflix, Steam, Visa and more). Filter by brand, country or category. Call this before purchasing to discover available offer IDs and prices.",
    {
      brand:    z.string().optional().describe("Brand name filter e.g. Amazon"),
      country:  z.string().optional().describe("ISO country code e.g. US"),
      category: z.string().optional().describe("Category slug e.g. shopping, gaming, entertainment"),
      limit:    z.number().optional().default(10).describe("Results per page"),
      offset:   z.number().optional().default(0).describe("Pagination offset"),
    },
    async ({ brand, country, category, limit, offset }) => {
      const api = buildHttpClient();
      const res = await api.get("/vouchers/offers", {
        params: { brand, country, category, limit, offset },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "get_voucher_offer",
    "Get full details for a specific voucher or gift card offer by ID — including exact price, denomination, currency, priceType (FIXED or RANGE), and requiredFields for the recipient. Call this before purchasing to confirm the exact payment amount.",
    {
      offerId: z.string().describe("Voucher offer ID e.g. 1-800-BASKETS_US_002_EGIFT"),
    },
    async ({ offerId }) => {
      const api = buildHttpClient();
      const res = await api.get(`/vouchers/offers/${offerId}`);
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "get_voucher_filters",
    "Get all valid filter values for the voucher catalog — available brand names, ISO country codes, and category slugs. Use before calling browse_voucher_offers to know what filter values are accepted.",
    {},
    async () => {
      const api = buildHttpClient();
      const res = await api.get("/vouchers/filters");
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "purchase_voucher",
    "Purchase a gift card or voucher. The x402 payment (USDC on Base) is handled automatically from the agent's wallet. Provide offerId from browse_voucher_offers. For RANGE priceType (open-value cards like Amazon), also supply value in USD. Returns orderId, txHash, and delivery (pinCode / redeemUrl) when available.",
    {
      offerId:   z.string().describe("Voucher offer ID from browse_voucher_offers"),
      firstName: z.string().describe("Recipient first name"),
      lastName:  z.string().describe("Recipient last name"),
      email:     z.string().optional().describe("Recipient email — required for some brands, check requiredFields on the offer"),
      country:   z.string().optional().describe("Recipient ISO country code — required for some brands"),
      value:     z.number().optional().describe("USD amount — RANGE priceType only (open-value cards). Omit for FIXED."),
    },
  async ({ offerId, firstName, lastName, email, country, value }) => {
  const api = buildHttpClient();
  const body = {
    offerId,
    recipient: { firstName, lastName, ...(email && { email }), ...(country && { country }) },
    ...(value !== undefined && { value }),
  };
  try {
    const res = await api.post("/vouchers/purchase", body);
    return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
  } catch (err) {
    console.error('[purchase_voucher error]', err?.message);
    console.error('[purchase_voucher status]', err?.response?.status);
    console.error('[purchase_voucher data]', JSON.stringify(err?.response?.data));
    console.error('[purchase_voucher stack]', err?.stack);
    throw err;
  }
}
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // TOPUP TOOLS
  // ─────────────────────────────────────────────────────────────────────────────

  server.tool(
    "browse_topup_offers",
    "Search prepaid mobile airtime and data top-up offers across 500+ operators in 150+ countries — including MTN, Airtel, Orange, Movistar, Digicel and more. Filter by country or operator. Call this before purchasing to discover available offer IDs and prices.",
    {
      country:  z.string().optional().describe("ISO country code e.g. GH, ES, NG"),
      operator: z.string().optional().describe("Operator name filter e.g. MTN, Airtel"),
      limit:    z.number().optional().default(10),
      offset:   z.number().optional().default(0),
    },
    async ({ country, operator, limit, offset }) => {
      const api = buildHttpClient();
      const res = await api.get("/topups/offers", {
        params: { country, operator, limit },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "get_topup_offer",
    "Get full details for a specific mobile top-up offer by ID — including price, operator, country, and required recipient fields.",
    {
      offerId: z.string().describe("Topup offer ID e.g. AIRTELTIGO_GH_025"),
    },
    async ({ offerId }) => {
      const api = buildHttpClient();
      const res = await api.get(`/topups/offers/${offerId}`);
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "purchase_topup",
    "Purchase a prepaid mobile airtime or data top-up. The x402 payment (USDC on Base) is handled automatically from the agent's wallet. Provide offerId from browse_topup_offers and the recipient phone number in E.164 format. Top-up is delivered directly to the recipient's SIM. Returns orderId and txHash — poll get_order for delivery confirmation.",
    {
      offerId: z.string().describe("Topup offer ID from browse_topup_offers"),
      msisdn:  z.string().describe("Recipient phone number in E.164 format e.g. +233201234567"),
    },
    async ({ offerId, msisdn }) => {
      const api = buildHttpClient();
      const res = await api.post("/topups/purchase", {
        offerId,
        recipient: { msisdn },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // ESIM TOOLS
  // ─────────────────────────────────────────────────────────────────────────────

  server.tool(
    "browse_esim_offers",
    "Browse eSIM data plans across 190+ countries and regions — including unlimited data plans, regional multi-country bundles, and global roaming. Filter by single country (e.g. ES) or by a multi-country region. Set regional:true to list ONLY multi-country regional bundles (e.g. ESIM-N-AMERICA-10D-UNLIMITED covering US+CA+MX); these have no single country code. Call this before purchasing to discover available offer IDs and prices.",
    {
      country: z.string().optional().describe("ISO country code for single-country plans, e.g. ES, US, JP. Omit when using regional/regions."),
      regions: z.enum([
        "Global", "Africa", "Asia", "Caribbean", "Central America",
        "Eastern Europe", "Western Europe", "North America", "Oceania",
        "South America", "South Asia", "Southeast Asia",
        "Middle East and North Africa",
      ]).optional().describe("Multi-country region to filter by (exact Zendit enum value)."),
      regional: z.boolean().optional().describe("true → return ONLY multi-country regional bundles (country is empty). Combine with `regions` to scope to one region."),
      limit:   z.number().optional().default(10),
      offset:  z.number().optional().default(0),
    },
    async ({ country, regions, regional, limit, offset }) => {
      const api = buildHttpClient();
      const res = await api.get("/esims/offers", {
        params: { country, regions, regional: regional ? "true" : undefined, limit, offset },
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "get_esim_offer",
    "Get full details for a specific eSIM plan by ID — including exact price, data allowance, duration, coverage countries, and whether data is unlimited.",
    {
      offerId: z.string().describe("eSIM offer ID e.g. ESIM-ES-7D-10GB-NOROAM"),
    },
    async ({ offerId }) => {
      const api = buildHttpClient();
      const res = await api.get(`/esims/offers/${offerId}`);
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "purchase_esim",
    "Purchase an eSIM data plan. The x402 payment (USDC on Base) is handled automatically from the agent's wallet. Provide offerId from browse_esim_offers. Returns orderId, txHash, ICCID and QR code (base64 PNG) when ready. If QR is not immediately available, poll get_order with the returned orderId.",
    {
      offerId: z.string().describe("eSIM offer ID from browse_esim_offers"),
      iccid:   z.string().optional().describe("Existing ICCID — only for top-up/recharge of an installed eSIM"),
    },
    async ({ offerId, iccid }) => {
      const api = buildHttpClient();
      const res = await api.post("/esims/purchase", {
        offerId,
        ...(iccid && { iccid }),
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // ORDER POLLING TOOLS (free — no payment)
  // ─────────────────────────────────────────────────────────────────────────────

  server.tool(
    "get_order",
    "Poll the fulfillment state of any purchase. Returns status (PROCESSING / FULFILLED / FULFILLMENT_FAILED / EXPIRED), delivery payload (ICCID, QR code, pin code, redeem URL), refund eligibility, and whether to keep polling. Use the orderId returned from any purchase tool. Free — no payment required.",
    {
      orderId: z.string().describe("Order UUID returned from any purchase tool"),
    },
    async ({ orderId }) => {
      const res = await axios.get(`${API_BASE}/orders/${orderId}`);
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "recover_order_by_txhash",
    "Recover a lost order using the on-chain transaction hash. Use this if the purchase response was lost (network drop etc.) but you have the txHash from the blockchain. Free — no payment required.",
    {
      txHash: z.string().describe("On-chain transaction hash from the purchase settlement e.g. 0xdeaed4..."),
    },
    async ({ txHash }) => {
      const res = await axios.get(`${API_BASE}/orders`, { params: { txHash } });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  server.tool(
    "claim_refund",
    "Claim a refund for a failed or expired eSIM order. Only eligible when status is FULFILLMENT_FAILED or EXPIRED and refund_policy is auto_on_fail. Requires the txHash from the original purchase response as proof of payment. Topup and voucher orders are non-refundable. Free — no payment required.",
    {
      orderId:        z.string().describe("Order UUID from the purchase response"),
      txHash:         z.string().describe("On-chain txHash from the purchase response — proves you are the original payer"),
      idempotencyKey: z.string().describe("Unique UUID for this refund request — prevents double submission"),
    },
    async ({ orderId, txHash, idempotencyKey }) => {
      const res = await axios.post(
        `${API_BASE}/orders/${orderId}/refund`,
        { txHash },
        { headers: { "Idempotency-Key": idempotencyKey } }
      );
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    }
  );

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streamable HTTP transport
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const sessions = new Map(); // sessionId → { server, transport }

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    // Existing session
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — must be an initialize request
    if (!isInitializeRequest(req.body)) {
      return res.status(400).json({ error: "Expected initialize request for new session" });
    }

    const newSessionId = randomUUID();
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });

    // Clean up on close
    transport.onclose = () => sessions.delete(newSessionId);

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// SSE notifications (GET /mcp)
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: "Invalid or missing session ID" });
  }
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

// Session termination (DELETE /mcp)
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ error: "Session not found" });
  }
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
  sessions.delete(sessionId);
});

app.get("/health", (_req, res) => res.json({ status: "ok", name: "reloadpi-mcp" }));

app.listen(PORT, () => {
  console.log(`🚀 Reloadpi MCP server listening on port ${PORT}`);
  console.log(`   MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`   Production:   https://mcp.reloadpi.com/mcp`);
});