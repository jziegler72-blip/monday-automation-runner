// netlify/functions/automations.js
//
// Routes:
//   GET    /api/automations        — list deployed automations
//   PUT    /api/automations/:id    — deploy/update an automation
//   DELETE /api/automations/:id    — remove an automation
//   POST   /api/webhook            — receive monday.com webhook events (signature verified)
//
// Environment variables (Netlify dashboard → Site → Environment variables):
//   SUPABASE_URL       — Supabase project URL (Settings > API)
//   SUPABASE_KEY       — Supabase service_role key (Settings > API)
//   MONDAY_SIGNING_SECRET — from monday.com webhook settings (used to verify payloads)
//   WEBHOOK_SECRET     — your own secret for builder → function auth
//   MONDAY_TOKEN       — monday.com API v2 token
//   ANTHROPIC_KEY      — optional, for AI step nodes

const MONDAY_API    = "https://api.monday.com/v2";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// ─── monday.com webhook signature verification ────────────────────────────────
// monday.com signs every webhook POST with an HMAC-SHA256 signature in the
// "x-monday-signature" header. We recompute it from the raw body and our
// signing secret and reject anything that doesn't match.
async function verifyMondaySignature(rawBody, signatureHeader) {
  const secret = process.env.MONDAY_SIGNING_SECRET;

  // If no signing secret is configured, skip verification (dev mode)
  if (!secret) return true;
  if (!signatureHeader) return false;

  // monday sends the signature as "sha256=<hex>"
  const [algo, receivedHex] = signatureHeader.split("=");
  if (algo !== "sha256" || !receivedHex) return false;

  // Compute expected HMAC-SHA256
  const encoder  = new TextEncoder();
  const keyData  = encoder.encode(secret);
  const msgData  = encoder.encode(rawBody);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);

  // Convert ArrayBuffer to hex string
  const expectedHex = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison to prevent timing attacks
  if (expectedHex.length !== receivedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ receivedHex.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
function supabase(path, method = "GET", body) {
  const url = `${process.env.SUPABASE_URL}/rest/v1${path}`;
  const key = process.env.SUPABASE_KEY;
  return fetch(url, {
    method,
    headers: {
      "Content-Type":  "application/json",
      "apikey":        key,
      "Authorization": `Bearer ${key}`,
      "Prefer":        method === "POST"
        ? "resolution=merge-duplicates,return=representation"
        : "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    const text = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  });
}

const dbList      = () => supabase("/automations?select=id,name,node_count,edge_count,is_active,deploy_status,deployed_at,updated_at&order=updated_at.desc");
const dbDelete    = id  => supabase(`/automations?id=eq.${id}`, "DELETE");
const dbGetActive = ()  => supabase("/automations?is_active=eq.true&select=*");

function dbUpsert(auto) {
  return supabase("/automations", "POST", {
    id:            auto.id,
    name:          auto.name,
    is_active:     auto.isActive     || false,
    deploy_status: auto.deployStatus || "deployed",
    node_count:    auto.nodeCount    || 0,
    edge_count:    auto.edgeCount    || 0,
    nodes:         auto.nodes,
    edges:         auto.edges,
    monday_token:  auto.mondayToken  || null,
    deployed_at:   auto.deployedAt   || new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  });
}

// ─── monday.com GraphQL ───────────────────────────────────────────────────────
async function mondayGQL(query, variables = {}, token) {
  const useToken = token || process.env.MONDAY_TOKEN;
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": useToken,
      "API-Version":   "2024-01",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

// ─── Webhook registration ─────────────────────────────────────────────────────
async function registerWebhooks(auto, siteUrl) {
  const token = auto.monday_token || auto.mondayToken || process.env.MONDAY_TOKEN;
  if (!token || !siteUrl) return;
  const webhookUrl = `${siteUrl}/api/webhook`;
  const eventMap   = {
    status_change:  "change_status_column_value",
    item_created:   "create_pulse",
    column_changed: "change_column_value",
    date_reached:   "when_date_arrived",
  };
  for (const node of (auto.nodes || []).filter(n => n.type === "trigger")) {
    const c     = node.config || {};
    const event = eventMap[node.subtype];
    if (!c.board || !event) continue;
    try {
      await mondayGQL(
        `mutation($b:ID!,$u:String!,$e:WebhookEventType!){create_webhook(board_id:$b,url:$u,event:$e){id}}`,
        { b: c.board, u: webhookUrl, e: event },
        token
      );
    } catch(e) {
      console.log("Webhook register note:", e.message);
    }
  }
}

// ─── Trigger matching ─────────────────────────────────────────────────────────
function triggerMatches(trigger, ctx) {
  const c = trigger.config || {};
  console.log("Checking trigger match:", JSON.stringify({
    triggerBoard: c.board, ctxBoard: ctx.boardId,
    triggerColumn: c.column, ctxColumn: ctx.columnId,
    triggerValue: c.toValue, ctxValue: ctx.newValue,
  }));
  switch (trigger.subtype) {
    case "status_change":
      return String(c.board) === ctx.boardId
        && (!c.column  || c.column  === ctx.columnId)
        && (!c.toValue || c.toValue === ctx.newValue);
    case "item_created":
      return String(c.board) === ctx.boardId && !ctx.columnId;
    case "column_changed":
      return String(c.board) === ctx.boardId
        && (!c.column || c.column === ctx.columnId);
    case "date_reached":
      return String(c.board) === ctx.boardId;
    default:
      return false;
  }
}

// ─── Condition evaluator ──────────────────────────────────────────────────────
function evalCondition(node, ctx) {
  const c   = node.config || {};
  const val = ctx.itemStatus;
  switch (c.operator) {
    case "equals":     return val === c.value             ? "yes" : "no";
    case "not_equals": return val !== c.value             ? "yes" : "no";
    case "contains":   return (val||"").includes(c.value) ? "yes" : "no";
    case "empty":      return !val                        ? "yes" : "no";
    case "not_empty":  return !!val                       ? "yes" : "no";
    default:           return "yes";
  }
}

// ─── Token resolution ─────────────────────────────────────────────────────────
function resolveTokens(str, ctx) {
  return (str || "")
    .replace(/\{\{item\.name\}\}/g,   ctx.itemName   || "")
    .replace(/\{\{item\.status\}\}/g, ctx.itemStatus  || "")
    .replace(/\{\{item\.id\}\}/g,     ctx.itemId      || "")
    .replace(/\{\{item\.owner\}\}/g,  ctx.userId      || "")
    .replace(/\{\{today\}\}/g,        new Date().toISOString().slice(0, 10))
    .replace(/\{\{ai\.output\}\}/g,   ctx.aiOutput    || "")
    .replace(/\{\{loop\.index\}\}/g,  String(ctx.loopIndex || 1));
}

// ─── Action executors ─────────────────────────────────────────────────────────
async function execAction(node, ctx, token) {
  const c = node.config || {};
  const useToken = token || process.env.MONDAY_TOKEN;
  try {
    switch (node.subtype) {

      case "create_group": {
        const name = resolveTokens(c.groupName || "New Group", ctx);
        const data = await mondayGQL(
          `mutation($b:ID!,$n:String!){create_group(board_id:$b,group_name:$n){id title}}`,
          { b: c.board, n: name },
          useToken
        );
        return { ok: true, result: `Created group "${data.create_group.title}"` };
      }

      case "create_item": {
        const name = resolveTokens(c.itemName || "New Item", ctx);
        const vars = { b: parseInt(c.board), n: name, cv: "{}" };
        if (c.group) vars.g = c.group;
        const data = await mondayGQL(
          `mutation($b:Int!,$n:String!,$g:String,$cv:JSON!){create_item(board_id:$b,item_name:$n,group_id:$g,column_values:$cv){id name}}`,
          vars,
          useToken
        );
        return { ok: true, result: `Created item "${data.create_item.name}"`, newItemId: data.create_item.id };
      }

      case "change_col": {
        if (!ctx.itemId) return { ok: false, result: "No itemId in context" };
        await mondayGQL(
          `mutation($b:Int!,$i:Int!,$c:String!,$v:JSON!){change_column_value(board_id:$b,item_id:$i,column_id:$c,value:$v){id}}`,
          { b: parseInt(c.board), i: parseInt(ctx.itemId), c: c.column, v: JSON.stringify({ label: c.toValue }) },
          useToken
        );
        return { ok: true, result: `Set "${c.column}" to "${c.toValue}"` };
      }

      case "move_item": {
        if (!ctx.itemId) return { ok: false, result: "No itemId in context" };
        await mondayGQL(
          `mutation($i:Int!,$g:String!){move_item_to_group(item_id:$i,group_id:$g){id}}`,
          { i: parseInt(ctx.itemId), g: c.group },
          useToken
        );
        return { ok: true, result: `Moved item to group "${c.group}"` };
      }

      case "http_request": {
        const url = resolveTokens(c.url || "", ctx);
        if (!url) return { ok: false, result: "No URL configured" };
        const res = await fetch(url, {
          method:  c.method || "POST",
          headers: { "Content-Type": "application/json" },
          body:    ["GET","HEAD"].includes(c.method) ? undefined : resolveTokens(c.body || "{}", ctx),
        });
        return { ok: res.ok, result: `${c.method} ${url} → ${res.status}` };
      }

      case "ai_step": {
        const key = process.env.ANTHROPIC_KEY;
        if (!key) return { ok: false, result: "ANTHROPIC_KEY not set in Netlify env vars" };
        const prompt = resolveTokens(c.prompt || "", ctx);
        const res    = await fetch(ANTHROPIC_API, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body:    JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
        });
        const data   = await res.json();
        const output = data.content?.[0]?.text || "";
        return { ok: true, result: output.slice(0, 200), aiOutput: output };
      }

      case "notify": {
        const msg = resolveTokens(c.message || "Automation triggered", ctx);
        if (ctx.itemId) {
          try {
            const me     = await mondayGQL(`{me{id}}`, {}, useToken);
            const userId = me?.me?.id;
            if (userId) {
              await mondayGQL(
                `mutation($u:Int!,$i:Int!,$m:String!){create_notification(user_id:$u,target_id:$i,text:$m,target_type:Project){text}}`,
                { u: parseInt(userId), i: parseInt(ctx.itemId), m: msg },
                useToken
              );
              return { ok: true, result: `Notified user ${userId}` };
            }
          } catch(e) { /* fall through */ }
        }
        return { ok: true, result: `Notification: "${msg.slice(0, 80)}"`, simulated: true };
      }

      default:
        return { ok: false, result: `Unknown action: ${node.subtype}` };
    }
  } catch(e) {
    return { ok: false, result: e.message };
  }
}

// ─── Automation runner ────────────────────────────────────────────────────────
async function runAutomation(auto, eventCtx) {
  const token = auto.monday_token || auto.mondayToken || process.env.MONDAY_TOKEN;
  const nodes = auto.nodes || [];
  const edges = auto.edges || [];
  const adj   = {};
  for (const e of edges) { (adj[e.from] = adj[e.from] || []).push(e); }

  const queue   = nodes.filter(n => n.type === "trigger").map(n => ({
    node: n, ctx: { ...eventCtx, aiOutput: "", loopIndex: 1 }
  }));
  const visited = new Set();

  while (queue.length > 0) {
    const { node, ctx } = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    const out = adj[node.id] || [];

    if (node.type === "trigger") {
      out.forEach(e => {
        const n = nodes.find(x => x.id === e.to);
        if (n) queue.push({ node: n, ctx: { ...ctx } });
      });

    } else if (node.type === "condition") {
      const port = evalCondition(node, ctx);
      out.filter(e => e.fromPort === port).forEach(e => {
        const n = nodes.find(x => x.id === e.to);
        if (n) queue.push({ node: n, ctx: { ...ctx } });
      });

    } else if (node.type === "action") {
      const result = await execAction(node, ctx, token);
      const next   = {
        ...ctx,
        ...(result.aiOutput  ? { aiOutput: result.aiOutput }  : {}),
        ...(result.newItemId ? { itemId:   result.newItemId } : {}),
      };
      out.forEach(e => {
        const n = nodes.find(x => x.id === e.to);
        if (n) queue.push({ node: n, ctx: next });
      });

    } else if (node.type === "wait") {
      const ms = (parseInt(node.config?.amount) || 1) *
        ({ minutes:60000, hours:3600000, "business days":86400000, weeks:604800000 }[node.config?.unit] || 60000);
      if (ms <= 20000) await new Promise(r => setTimeout(r, ms));
      out.forEach(e => {
        const n = nodes.find(x => x.id === e.to);
        if (n) queue.push({ node: n, ctx: { ...ctx } });
      });

    } else if (node.type === "loop") {
      const count = parseInt(node.config?.count || "3");
      for (let i = 1; i <= count; i++) {
        out.forEach(e => {
          const n = nodes.find(x => x.id === e.to);
          if (n) queue.push({ node: n, ctx: { ...ctx, loopIndex: i } });
        });
      }
    }
  }
}

// ─── Response helper + CORS ───────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-automation-secret",
};
const resp = (body, status = 200) => ({
  statusCode: status,
  headers: { ...CORS, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function handler(event) {
  const method  = event.httpMethod;
  const path    = event.path || "";
  const headers = event.headers || {};

  // CORS preflight
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  // ── monday.com webhook (POST /api/webhook) ────────────────────────────────
  if (path.endsWith("/webhook") && method === "POST") {
    const rawBody  = event.body || "";
    const sigHeader = headers["x-monday-signature"] || headers["x-monday-webhooks-signature"] || "";

    // monday sends a GET challenge on first registration
    if (method === "GET") {
      const challenge = new URLSearchParams(event.rawQuery || "").get("challenge");
      if (challenge) return resp({ challenge });
    }

    // Verify the signature — reject anything not from monday.com
    const valid = await verifyMondaySignature(rawBody, sigHeader);
    if (!valid) {
      console.warn("Webhook signature verification failed — request rejected");
      return resp({ error: "Invalid signature" }, 401);
    }

    let body;
    try { body = JSON.parse(rawBody); } catch { return resp({ ok: false }, 400); }

    // monday sends a challenge in the POST body on first registration too
    if (body.challenge) return resp({ challenge: body.challenge });

    const ev = body.event;
    if (!ev) return resp({ ok: true });

    // Log the full event for debugging
    console.log("Webhook event received:", JSON.stringify({
      boardId: ev.boardId,
      itemId: ev.pulseId || ev.itemId,
      columnId: ev.columnId,
      value: ev.value,
      previousValue: ev.previousValue,
    }));

    const ctx = {
      boardId:    String(ev.boardId || ""),
      itemId:     String(ev.pulseId || ev.itemId || ""),
      itemName:   ev.pulseName || ev.itemName || "",
      columnId:   ev.columnId || "",
      newValue:   ev.value?.label?.text || ev.value?.name || (typeof ev.value === "string" ? ev.value : "") || "",
      itemStatus: ev.value?.label?.text || ev.value?.name || "",
      userId:     String(ev.userId || ""),
      aiOutput:   "",
    };

    console.log("Parsed ctx:", JSON.stringify(ctx));

    // Find matching active automations and run them
    const all     = await dbGetActive();
    const matched = (all || []).filter(a =>
      (a.nodes || []).filter(n => n.type === "trigger").some(t => triggerMatches(t, ctx))
    );

    // Run without awaiting so we respond to monday within their 5s window
    Promise.allSettled(matched.map(a => runAutomation(a, ctx)));
    return resp({ ok: true, matched: matched.length });
  }

  // monday GET challenge (some versions send it as GET)
  if (path.endsWith("/webhook") && method === "GET") {
    const challenge = new URLSearchParams(event.rawQuery || "").get("challenge");
    if (challenge) return resp({ challenge });
    return resp({ ok: true });
  }

  // ── monday.com GraphQL proxy (solves browser CORS) ───────────────────────
  // The builder calls POST /api/monday with { token, query, variables }
  // We forward it server-side where CORS doesn't apply.
  if (path.includes("monday") && !path.includes("webhook")) {
    // GET = health check for the proxy
    if (method === "GET") return resp({ ok: true, proxy: "monday" });
    if (method === "POST") {
      try {
        const { token, query, variables } = JSON.parse(event.body || "{}");
        const useToken = token || process.env.MONDAY_TOKEN;
        if (!useToken) return resp({ error: "No monday token provided" }, 400);
        const res = await fetch("https://api.monday.com/v2", {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": useToken,
            "API-Version":   "2024-01",
          },
          body: JSON.stringify({ query, variables: variables || {} }),
        });
        const data = await res.json();
        return resp(data);
      } catch(e) { return resp({ error: e.message }, 500); }
    }
  }

  // ── Management API (called from the builder) ──────────────────────────────
  // The builder is hosted on the same Netlify domain, so we trust same-origin
  // requests. We also support the x-automation-secret header for external access.
  const secret = process.env.WEBHOOK_SECRET || "";
  const receivedSecret = headers["x-automation-secret"] || "";
  const origin = headers["origin"] || headers["referer"] || "";
  const host = headers["host"] || "";
  const isSameOrigin = origin.includes(host) || origin === "" || !origin;
  
  if (secret && receivedSecret !== secret && !isSameOrigin) {
    console.log(`Forbidden: origin="${origin}" host="${host}"`);
    return resp({ error: "Forbidden" }, 403);
  }

  // GET — list all automations
  if (method === "GET" && path.includes("/automations")) {
    try { return resp({ automations: await dbList() || [] }); }
    catch(e) { return resp({ error: e.message }, 500); }
  }

  // PUT — deploy or update an automation
  if (method === "PUT" && path.includes("/automations/")) {
    try {
      const auto    = JSON.parse(event.body || "{}");
      const siteUrl = `${headers["x-forwarded-proto"] || "https"}://${headers["host"]}`;
      await dbUpsert(auto);
      registerWebhooks(auto, siteUrl).catch(() => {});
      return resp({ ok: true, id: auto.id });
    } catch(e) { return resp({ error: e.message }, 500); }
  }

  // DELETE — remove an automation
  if (method === "DELETE" && path.includes("/automations/")) {
    try { await dbDelete(path.split("/").pop()); return resp({ ok: true }); }
    catch(e) { return resp({ error: e.message }, 500); }
  }

  // Health check
  if (method === "GET") return resp({ ok: true, ts: Date.now() });

  return resp({ error: "Not found" }, 404);
}
