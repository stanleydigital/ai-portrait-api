export const config = { runtime: "edge" };

// Simple analytics tracker for conversion funnel
// Tracks: upload_started, generation_started, generation_completed, cart_added

const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com"
]);

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    headers: {
      "Content-Type": "application/json",
      ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  };
}

let kv: any = null;

async function initKV() {
  if (kv) return kv;
  
  try {
    // @ts-ignore
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    return null;
  }
}

export default async function handler(req: Request) {
  const origin = req.headers.get("origin");
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...cors(origin) });
  }
  
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...cors(origin) });
  }
  
  try {
    const body = await req.json().catch(() => ({}));
    const { event, properties = {} } = body;
    
    if (!event) {
      return new Response(JSON.stringify({ error: "Missing event" }), {
        status: 400, ...cors(origin)
      });
    }
    
    // Get user identifier
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const timestamp = Date.now();
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    const kvClient = await initKV();
    
    if (kvClient) {
      // Increment daily counter for this event
      const dailyKey = `analytics:${date}:${event}`;
      await kvClient.incr(dailyKey);
      await kvClient.expire(dailyKey, 2592000); // 30 days
      
      // Store individual event (for detailed analysis)
      const eventKey = `event:${timestamp}:${event}:${ip}`;
      await kvClient.set(eventKey, {
        event,
        ip,
        timestamp,
        properties
      }, { ex: 86400 }); // 24 hours
      
      console.log(`📊 Analytics: ${event} (${date})`);
    } else {
      // Fallback: just log to console
      console.log(`📊 Analytics (no KV): ${event}`, properties);
    }
    
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, ...cors(origin)
    });
    
  } catch (err: any) {
    console.error("Analytics error:", err);
    // Always return 200 for analytics (fire-and-forget)
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, ...cors(origin)
    });
  }
}
