// mcp.reloadpi.com — Reloadpi MCP Server
// Exposes Reloadpi catalog as MCP tools.
//
// Two modes, decided by whether EVM_PRIVATE_KEY is present:
//
//   • Browse-only mode (NO EVM_PRIVATE_KEY) — safe for public hosting.
//       Browse / filter / order tools only. They hit the FREE /ai API, so the
//       server never holds or spends a wallet. This is what mcp.reloadpi.com runs.
//
//   • Purchase mode (EVM_PRIVATE_KEY set) — for self-hosters (npx / local).
//       Adds get_*_offer (paid detail) and purchase_* tools that settle x402
//       payments from the operator's OWN wallet. Never set this on the public host.
//
// Transport: Streamable HTTP — compatible with Claude Desktop 2025/2026.

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
import { normalizeRoamingCountries } from "./lib/countries.js";

// ── Config ────────────────────────────────────────────────────────────────────

// Paid x402 routes (offer detail + purchase). Only used in purchase mode.
const API_BASE = process.env.RELOADPI_API_BASE ?? "https://api.reloadpi.com/api/catalog";
// Free, walletless browse API. Used for all browse/filter tools in both modes.
const AI_BASE  = process.env.RELOADPI_AI_BASE  ?? "https://api.reloadpi.com/ai";
const PORT     = process.env.PORT ?? 3100;

// Optional shared-secret gate for /mcp. OFF by default so the public browse
// server stays open to anonymous MCP clients. Set MCP_AUTH_TOKEN to require
// `Authorization: Bearer <token>` (useful for a private self-hosted instance).
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() || null;

const HAS_WALLET = Boolean(process.env.EVM_PRIVATE_KEY);

// Transport: default HTTP (for the hosted server). Pass --stdio (or MCP_STDIO=1)
// when an MCP client spawns this process locally via `command`/`args` — Claude
// Desktop and Cursor talk to spawned servers over stdio, not HTTP.
const STDIO = process.argv.includes("--stdio") || process.env.MCP_STDIO === "1";

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

// ── HTTP clients ────────────────────────────────────────────────────────────

// Free browse client — no wallet, never pays.
const freeApi = axios.create({ baseURL: AI_BASE });

// Paid x402 client — built lazily, only when a wallet is configured.
function buildPaidClient() {
  if (!HAS_WALLET) {
    throw new Error(
      "This tool requires a funded wallet. Self-host reloadpi-mcp with EVM_PRIVATE_KEY " +
      "in your MCP config env to enable offer-detail and purchase tools."
    );
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

// Every tool result goes out through here, so this is the one place that has
// to normalize the payload: ISO-2 codes in `roamingCountries` are expanded to
// full country names (with the raw codes kept as `roamingCountriesCodes`) so a
// client reading the response can tell what a bundle covers without knowing the
// code table. Upstream requests and the offer schema are untouched.
const asText = (data) => ({
  content: [{ type: "text", text: JSON.stringify(normalizeRoamingCountries(data)) }],
});

// ── MCP server factory (one per session) ─────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name:    "reloadpi",
    version: "1.2.0",
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FREE TOOLS — always available, no wallet. Backed by the /ai browse API.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Vouchers (browse) ──────────────────────────────────────────────────────

  server.tool(
    "browse_voucher_offers",
    "Search gift cards and vouchers from 5000+ brands across 150+ countries (Amazon, Google Play, Netflix, Steam, Visa and more). Filter by brand, country or category. Free — no payment. Returns offer IDs and prices; use them with purchase_voucher (requires a self-hosted wallet).",
    {
      brand:    z.string().optional().describe("Brand name filter e.g. Amazon"),
      country:  z.string().optional().describe("ISO country code e.g. US"),
      category: z.string().optional().describe("Category slug e.g. shopping, gaming, entertainment"),
      limit:    z.number().optional().default(10).describe("Results per page (max 50)"),
      offset:   z.number().optional().default(0).describe("Pagination offset"),
    },
    async ({ brand, country, category, limit, offset }) => {
      const res = await freeApi.get("/vouchers", {
        params: { brand, country, subType: category, limit, offset },
      });
      return asText(res.data);
    }
  );

  server.tool(
    "get_voucher_filters",
    "Get all valid filter values for the voucher catalog — available brand names, ISO country codes, category slugs and regions. Free — no payment. Use before browse_voucher_offers to know what filter values are accepted.",
    {},
    async () => {
      const res = await freeApi.get("/capabilities");
      return asText(res.data?.vouchers ?? res.data);
    }
  );

  // ── Topups (browse) ────────────────────────────────────────────────────────

  server.tool(
    "browse_topup_offers",
    "Search prepaid mobile airtime and data top-up offers across 500+ operators in 150+ countries — including MTN, Airtel, Orange, Movistar, Digicel and more. Filter by country or operator. Free — no payment. Returns offer IDs and prices; use them with purchase_topup (requires a self-hosted wallet).",
    {
      country:  z.string().optional().describe("ISO country code e.g. GH, ES, NG"),
      operator: z.string().optional().describe("Operator name filter e.g. MTN, Airtel"),
      limit:    z.number().optional().default(10),
      offset:   z.number().optional().default(0),
    },
    async ({ country, operator, limit, offset }) => {
      const res = await freeApi.get("/topups", {
        params: { country, brand: operator, limit, offset },
      });
      return asText(res.data);
    }
  );

  // ── eSIMs (browse) ─────────────────────────────────────────────────────────

  // The catalog tags every offer with exactly ONE region, and that taxonomy
  // PARTITIONS rather than nests: "Asia" does not contain Thailand or Vietnam
  // (both "Southeast Asia") or India ("South Asia"). Two disjoint valid sets
  // follow from that, so each browse mode gets its own enum:
  //
  //   REGION_TAGS      — every tag in the catalog; valid for single-country browse.
  //   REGIONAL_REGIONS — the only tags that have multi-country bundles behind them.
  //
  // "South America" (340 plans), "Southeast Asia" (225) and "South Asia" (116)
  // are deliberately absent from REGIONAL_REGIONS: they have single-country
  // plans but ZERO regional bundles, so offering them as a regional scope would
  // advertise a menu option that cannot return anything.
  //
  // These are static rather than derived at runtime because an MCP tool's
  // inputSchema must exist synchronously at registration time — deriving them
  // from a live fetch would make tool registration depend on the catalog API
  // being reachable at boot, and would leave the enum empty (an invalid schema)
  // if that call failed. Re-check both lists whenever Zendit's catalog changes:
  //   curl -s 'https://api.reloadpi.com/ai/esims?regional=true&limit=200' \
  //     | jq -r '.items[].regions[]' | sort -u   # → REGIONAL_REGIONS
  //   curl -s 'https://api.reloadpi.com/ai/esims?limit=200' \
  //     | jq -r '.items[].regions[]' | sort -u   # → REGION_TAGS
  const REGION_TAGS = [
    "Global", "Africa", "Asia", "Caribbean", "Central America",
    "Eastern Europe", "Western Europe", "North America", "Oceania",
    "South America", "South Asia", "Southeast Asia",
    "Middle East and North Africa",
  ];
  const REGIONAL_REGIONS = [
    "Africa", "Asia", "Caribbean", "Central America", "Eastern Europe",
    "Global", "Middle East and North Africa", "North America", "Oceania",
    "Western Europe",
  ];

  server.tool(
    "browse_esim_offers",
    "Browse eSIM data plans across 190+ countries — single-country plans and multi-country regional bundles. " +
    "CHOOSE THE RIGHT FILTER: `country` (ISO-2, e.g. JP) for one specific country; " +
    "`regions` to browse SINGLE-COUNTRY plans grouped by area; " +
    "`regional_region` to get MULTI-COUNTRY regional bundles covering an area (this already implies regional-only — do not also set `regional`); " +
    "`regional:true` on its own to list every regional bundle. " +
    "IMPORTANT — the region taxonomy PARTITIONS and does NOT nest: \"Asia\" does NOT include Thailand or Vietnam (both \"Southeast Asia\") or India (\"South Asia\"). " +
    "So for a Thailand plan use country:\"TH\", or regions:\"Southeast Asia\" for all single-country plans in that area. " +
    "Regional bundles exist only for the values offered by `regional_region`; \"Southeast Asia\", \"South Asia\" and \"South America\" have single-country plans but no bundles, which is why `regional_region` does not offer them. " +
    "Results include roamingCountries / roamingCount, the countries a regional bundle actually covers — roamingCountries holds full country names (with the raw ISO-2 codes in roamingCountriesCodes); check these to confirm a bundle includes the countries the user needs. " +
    "Free — no payment. Returns offer IDs and prices; use them with purchase_esim (requires a self-hosted wallet).",
    {
      country: z.string().optional().describe("ISO-2 country code for one specific country, e.g. ES, US, JP."),
      regions: z.enum(REGION_TAGS).optional().describe("Browse SINGLE-COUNTRY plans by area (exact tag). Partitions, does not nest: Thailand/Vietnam are \"Southeast Asia\", India is \"South Asia\", Japan/Hong Kong are \"Asia\". Do NOT use this to find regional bundles — use regional_region instead."),
      regional_region: z.enum(REGIONAL_REGIONS).optional().describe("Get MULTI-COUNTRY regional bundles covering this area. Implies regional-only, so `regional` need not be set. Every value offered here has bundles behind it. Takes precedence over `regions`."),
      regional: z.boolean().optional().describe("true → return ONLY multi-country regional bundles. Use alone to list them all; to scope to one area use regional_region instead."),
      q:       z.string().optional().describe("Free-text filter e.g. \"10GB\", \"unlimited\""),
      limit:   z.number().optional().default(10),
      offset:  z.number().optional().default(0),
    },
    async ({ country, regions, regional_region, regional, q, limit, offset }) => {
      // regional_region is the regional-mode scope: it implies regional-only and
      // wins over `regions`, which is the single-country-mode scope.
      const regionalOnly = regional === true || Boolean(regional_region);
      const region = regional_region ?? regions;

      // `regional_region` is enum-constrained, but `regional:true` + `regions`
      // can still express a region that has no bundles (e.g. "Southeast Asia").
      // Answer with explicit guidance rather than an unexplained empty list —
      // and never by silently widening the search, which would let the caller
      // present an unrelated bundle as if it matched the requested area.
      if (regionalOnly && region && !REGIONAL_REGIONS.includes(region)) {
        return asText({
          total: 0,
          items: [],
          error: `No multi-country regional bundles exist for "${region}".`,
          valid_regional_regions: REGIONAL_REGIONS,
          hint: `"${region}" tags single-country plans only. For regional bundles pass regional_region with one of valid_regional_regions. For single-country plans in this area, pass regions:"${region}" and omit regional.`,
        });
      }

      const res = await freeApi.get("/esims", {
        params: {
          country,
          regions:  region,
          regional: regionalOnly ? "true" : undefined,
          q, limit, offset,
        },
      });
      return asText(res.data);
    }
  );

  // ── Order polling & refunds (free — no payment) ────────────────────────────

  server.tool(
    "get_order",
    "Poll the fulfillment state of any purchase. Returns status (PROCESSING / FULFILLED / FULFILLMENT_FAILED / EXPIRED), delivery payload (ICCID, QR code, pin code, redeem URL), refund eligibility, and whether to keep polling. Use the orderId returned from any purchase tool. Free — no payment required.",
    {
      orderId: z.string().describe("Order UUID returned from any purchase tool"),
    },
    async ({ orderId }) => {
      const res = await axios.get(`${API_BASE}/orders/${orderId}`);
      return asText(res.data);
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
      return asText(res.data);
    }
  );

  server.tool(
    "claim_refund",
    "Claim a refund for a failed or expired eSIM order, or a carrier-rejected topup. Only eligible when status is FULFILLMENT_FAILED or EXPIRED and refund_policy is auto_on_fail. Requires the txHash from the original purchase response as proof of payment. Voucher orders and successfully delivered topups are non-refundable. Free — no payment required.",
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
      return asText(res.data);
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PAID TOOLS — only registered when EVM_PRIVATE_KEY is set (self-host).
  // These settle x402 payments from the operator's OWN wallet. They are NOT
  // present on the public hosted server, so it can never spend.
  // ═══════════════════════════════════════════════════════════════════════════

  if (!HAS_WALLET) {
    return server;
  }

  // ── Offer detail (paid $0.001 x402) ────────────────────────────────────────

  server.tool(
    "get_voucher_offer",
    "Get full details for a specific voucher or gift card offer by ID — exact price, denomination, currency, priceType (FIXED or RANGE), and requiredFields for the recipient. Costs a small x402 fee from your wallet. Call before purchasing to confirm the exact payment amount.",
    {
      offerId: z.string().describe("Voucher offer ID e.g. 1-800-BASKETS_US_002_EGIFT"),
    },
    async ({ offerId }) => {
      const api = buildPaidClient();
      const res = await api.get(`/vouchers/offers/${offerId}`);
      return asText(res.data);
    }
  );

  server.tool(
    "get_topup_offer",
    "Get full details for a specific mobile top-up offer by ID — price, operator, country, and required recipient fields. Costs a small x402 fee from your wallet.",
    {
      offerId: z.string().describe("Topup offer ID e.g. AIRTELTIGO_GH_025"),
    },
    async ({ offerId }) => {
      const api = buildPaidClient();
      const res = await api.get(`/topups/offers/${offerId}`);
      return asText(res.data);
    }
  );

  server.tool(
    "get_esim_offer",
    "Get full details for a specific eSIM plan by ID — exact price, data allowance, duration, coverage countries, and whether data is unlimited. Costs a small x402 fee from your wallet.",
    {
      offerId: z.string().describe("eSIM offer ID e.g. ESIM-ES-7D-10GB-NOROAM"),
    },
    async ({ offerId }) => {
      const api = buildPaidClient();
      const res = await api.get(`/esims/offers/${offerId}`);
      return asText(res.data);
    }
  );

  // ── Purchase (paid — product price + markup, x402) ─────────────────────────

  server.tool(
    "purchase_voucher",
    "Purchase a gift card or voucher. The x402 payment (USDC on Base) settles automatically from YOUR wallet. Provide offerId from browse_voucher_offers. For RANGE priceType (open-value cards like Amazon), also supply value in USD. Returns orderId, txHash, and delivery (pinCode / redeemUrl) when available.",
    {
      offerId:   z.string().describe("Voucher offer ID from browse_voucher_offers"),
      firstName: z.string().describe("Recipient first name"),
      lastName:  z.string().describe("Recipient last name"),
      email:     z.string().optional().describe("Recipient email — required for some brands, check requiredFields on the offer"),
      country:   z.string().optional().describe("Recipient ISO country code — required for some brands"),
      value:     z.number().optional().describe("USD amount — RANGE priceType only (open-value cards). Omit for FIXED."),
    },
    async ({ offerId, firstName, lastName, email, country, value }) => {
      const api = buildPaidClient();
      const body = {
        offerId,
        recipient: { firstName, lastName, ...(email && { email }), ...(country && { country }) },
        ...(value !== undefined && { value }),
      };
      try {
        const res = await api.post("/vouchers/purchase", body);
        return asText(res.data);
      } catch (err) {
        console.error("[purchase_voucher error]", err?.message);
        console.error("[purchase_voucher status]", err?.response?.status);
        console.error("[purchase_voucher data]", JSON.stringify(err?.response?.data));
        throw err;
      }
    }
  );

  server.tool(
    "purchase_topup",
    "Purchase a prepaid mobile airtime or data top-up. The x402 payment (USDC on Base) settles automatically from YOUR wallet. Provide offerId from browse_topup_offers and the recipient phone number in E.164 format. Delivered directly to the recipient's SIM. Returns orderId and txHash — poll get_order for delivery confirmation.",
    {
      offerId: z.string().describe("Topup offer ID from browse_topup_offers"),
      msisdn:  z.string().describe("Recipient phone number in E.164 format e.g. +233201234567"),
    },
    async ({ offerId, msisdn }) => {
      const api = buildPaidClient();
      const res = await api.post("/topups/purchase", {
        offerId,
        recipient: { msisdn },
      });
      return asText(res.data);
    }
  );

  server.tool(
    "purchase_esim",
    "Purchase an eSIM data plan. The x402 payment (USDC on Base) settles automatically from YOUR wallet. Provide offerId from browse_esim_offers. Returns orderId, txHash, ICCID and QR code (base64 PNG) when ready. If QR is not immediately available, poll get_order with the returned orderId.",
    {
      offerId: z.string().describe("eSIM offer ID from browse_esim_offers"),
      iccid:   z.string().optional().describe("Existing ICCID — only for top-up/recharge of an installed eSIM"),
    },
    async ({ offerId, iccid }) => {
      const api = buildPaidClient();
      const res = await api.post("/esims/purchase", {
        offerId,
        ...(iccid && { iccid }),
      });
      return asText(res.data);
    }
  );

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streamable HTTP transport
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Optional bearer-token gate. No-op unless MCP_AUTH_TOKEN is set.
function authorized(req, res) {
  if (!MCP_AUTH_TOKEN) return true;
  const header = req.headers["authorization"] ?? "";
  if (header === `Bearer ${MCP_AUTH_TOKEN}`) return true;
  res.status(401).json({ error: "Unauthorized" });
  return false;
}

const sessions = new Map(); // sessionId → { server, transport }

app.post("/mcp", async (req, res) => {
  if (!authorized(req, res)) return;
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
  if (!authorized(req, res)) return;
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: "Invalid or missing session ID" });
  }
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

// Session termination (DELETE /mcp)
app.delete("/mcp", async (req, res) => {
  if (!authorized(req, res)) return;
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ error: "Session not found" });
  }
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
  sessions.delete(sessionId);
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", name: "reloadpi-mcp", mode: HAS_WALLET ? "purchase" : "browse-only" })
);

// In stdio mode we must NOT write to stdout (it's the MCP channel) — log to stderr.
function logModeToStderr(prefix) {
  if (HAS_WALLET) {
    try {
      const addr = privateKeyToAccount(process.env.EVM_PRIVATE_KEY).address;
      console.error(`${prefix}💳 Purchase mode — signing from ${addr}`);
    } catch {
      console.error(`${prefix}💳 Purchase mode — EVM_PRIVATE_KEY set`);
    }
  } else {
    console.error(`${prefix}🔎 Browse-only mode — no wallet; purchase tools disabled`);
  }
}

if (STDIO) {
  // Local, client-spawned server (npx via Claude/Cursor `command`/`args`).
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  logModeToStderr("reloadpi-mcp (stdio) ready — ");
} else {
  // Hosted / HTTP server.
  app.listen(PORT, () => {
    console.log(`🚀 Reloadpi MCP server listening on port ${PORT}`);
    console.log(`   MCP endpoint: http://localhost:${PORT}/mcp`);
    if (HAS_WALLET) {
      logModeToStderr("   ");
      console.error(`   ⚠️  Do NOT run this on a public host; anyone who connects could spend`);
      console.error(`      this wallet. Public hosting must omit EVM_PRIVATE_KEY.`);
    } else {
      console.log(`   🔎 Browse-only mode — no wallet; purchase tools disabled (safe for public hosting)`);
    }
    if (MCP_AUTH_TOKEN) console.log(`   🔒 /mcp requires Authorization: Bearer <MCP_AUTH_TOKEN>`);
  });
}
