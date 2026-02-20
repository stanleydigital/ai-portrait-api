export const config = { runtime: "edge" };

// --- Allow-list of origins that can call your API ---
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
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Vary": "Origin"
    }
  };
}

// ------- RATE LIMITING with Vercel KV (PRODUCTION READY) -------
// Install: npm install @vercel/kv
// Set env vars: KV_URL, KV_REST_API_URL, KV_REST_API_TOKEN, KV_REST_API_READ_ONLY_TOKEN

let kv: any = null;

async function initKV() {
  if (kv) return kv;
  
  try {
    // @ts-ignore
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    console.warn("⚠️ Vercel KV not available, falling back to in-memory rate limiting");
    return null;
  }
}

// Fallback in-memory rate limiting (if KV not configured)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

async function checkRateLimit(identifier: string, maxRequests = 50, windowMs = 3600000): Promise<boolean> {
  const kvClient = await initKV();
  
  if (kvClient) {
    // Use Redis for persistent rate limiting
    const key = `ratelimit:preview:${identifier}`;
    const count = await kvClient.incr(key);
    
    if (count === 1) {
      await kvClient.expire(key, Math.floor(windowMs / 1000));
    }
    
    return count <= maxRequests;
  } else {
    // Fallback to in-memory
    const now = Date.now();
    const record = rateLimitMap.get(identifier);
    
    if (!record || now > record.resetAt) {
      rateLimitMap.set(identifier, { count: 1, resetAt: now + windowMs });
      return true;
    }
    
    if (record.count >= maxRequests) {
      return false;
    }
    
    record.count++;
    return true;
  }
}

// ------- MAIN HANDLER -------
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");
  
  // --- CORS preflight ---
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...cors(origin) });
  }
  
  // --- Optional health check ---
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: true,
        hint: "POST JSON { imageUrl, prompt } to start generation."
      }),
      { status: 200, ...cors(origin) }
    );
  }
  
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...cors(origin) });
  }
  
  try {
    // --- Rate limiting: 20 generations per hour per IP ---
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || "unknown";
    
    if (!await checkRateLimit(ip, 50, 3600000)) {
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded. You can generate 20 portraits per hour. Please try again later."
        }),
        {
          status: 429,
          ...cors(origin)
        }
      );
    }
    
    const body = await req.json().catch(() => ({}));
    
    // --- Normalize client input ---
    const imageUrl: string | undefined = body.imageUrl || body.image_url;
    const prompt: string = (body.prompt || body.style || "").trim();
    
    if (!imageUrl) {
      return new Response(JSON.stringify({ error: "Missing imageUrl" }), {
        status: 400,
        ...cors(origin)
      });
    }
    
    // Validate image URL (basic security check)
    try {
      const url = new URL(imageUrl);
      if (!url.protocol.startsWith("http")) {
        return new Response(JSON.stringify({ error: "Invalid image URL" }), {
          status: 400,
          ...cors(origin)
        });
      }
    } catch {
      return new Response(JSON.stringify({ error: "Invalid image URL format" }), {
        status: 400,
        ...cors(origin)
      });
    }
    
    // OPTIMIZATION: Use Cloudinary transformations to optimize image before sending to Replicate
let optimizedImageUrl = imageUrl;
if (/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(imageUrl)) {
  optimizedImageUrl = imageUrl.replace(
    "/upload/",
    "/upload/f_auto,q_auto,w_2048,h_2048,c_fit/"
  );
}
    
    // Stronger prompt to avoid generic results
    const finalPrompt =
      (prompt ? prompt + " " : "") +
      "Preserve the exact identity from the uploaded photo (same markings, colors, and features). Centered subject, clean background.";
    
    // ✅ Send ALL commonly accepted keys so any Seedream build uses the image & text
    const input: Record<string, any> = {
      // image
      image_input: [optimizedImageUrl], // <-- primary key many Seedream-4 builds require
      //image_url: optimizedImageUrl, // <-- secondary (harmless backup)
      // text
      prompt: finalPrompt, // standard
      //style: finalPrompt, // alt
      //text_prompt: finalPrompt, // alt
      // size
      size: "custom",
      width: 3072,
      height: 4096
    };
    
    // --- Get webhook URL for this deployment ---
    const deploymentUrl = req.url.replace(/\/api\/preview.*$/, "");
    const webhookUrl = `${deploymentUrl}/api/webhook`;
    
    // --- Call Replicate with webhook ---
    const replicateUrl =
      "https://api.replicate.com/v1/models/bytedance/seedream-4/predictions";
    
    const replicateRes = await fetch(replicateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`
      },
      body: JSON.stringify({ 
        input,
        webhook: webhookUrl,
        webhook_events_filter: ["completed"]
      })
    });
    
    const text = await replicateRes.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Non-JSON response from Replicate:", text);
    }
    
    // after calling Replicate and parsing `data`
    if (replicateRes.ok && data?.id) {
      return new Response(
        JSON.stringify({
          id: data.id,
          status: data.status || "queued",
          get_url: data?.urls?.get || null,
          echo: input // keep this while debugging
        }),
        { status: 200, ...cors(origin) }
      );
    }
    
    // --- Error: forward Replicate's message to client ---
    const errMsg = data?.error || text || `Replicate error ${replicateRes.status}`;
    console.error("Replicate error:", errMsg);
    return new Response(JSON.stringify({ error: errMsg }), {
      status: replicateRes.status || 500,
      ...cors(origin)
    });
  } catch (err: any) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: err?.message || "preview_failed" }), {
      status: 500,
      ...cors(origin)
    });
  }
}
