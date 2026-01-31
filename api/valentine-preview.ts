export const config = { runtime: "edge" };

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
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    console.warn("⚠️ Vercel KV not available");
    return null;
  }
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

async function checkRateLimit(identifier: string, maxRequests = 50, windowMs = 3600000): Promise<boolean> {
  const kvClient = await initKV();
  
  if (kvClient) {
    const key = `ratelimit:valentine:${identifier}`;
    const count = await kvClient.incr(key);
    
    if (count === 1) {
      await kvClient.expire(key, Math.floor(windowMs / 1000));
    }
    
    return count <= maxRequests;
  } else {
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

export default async function handler(req: Request) {
  const origin = req.headers.get("origin");
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...cors(origin) });
  }
  
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...cors(origin) });
  }
  
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || "unknown";
    
    if (!await checkRateLimit(ip, 50, 3600000)) {
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded. Please try again later."
        }),
        { status: 429, ...cors(origin) }
      );
    }
    
    const body = await req.json().catch(() => ({}));
    
    const templateUrl: string | undefined = body.templateUrl;
    const userPhotoUrl: string | undefined = body.userPhotoUrl;
    
    console.log('📥 Workflow request:');
    console.log('  Template:', templateUrl);
    console.log('  User photo:', userPhotoUrl);
    
    if (!templateUrl || !userPhotoUrl) {
      return new Response(
        JSON.stringify({ error: "Missing templateUrl or userPhotoUrl" }),
        { status: 400, ...cors(origin) }
      );
    }
    
    try {
      new URL(templateUrl);
      new URL(userPhotoUrl);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid image URL format" }),
        { status: 400, ...cors(origin) }
      );
    }
    
    console.log('📤 Submitting to workflow queue...');
    
    // Use the QUEUE endpoint for workflows (same as models)
    const falResponse = await fetch('https://fal.run/workflows/stanrazvanneugen/cards', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${process.env.FAL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        template_url: templateUrl,
        user_photo_url: userPhotoUrl
      })
    });
    
    const falText = await falResponse.text();
    console.log('📥 fal.ai raw response:', falText);
    console.log('📥 fal.ai status:', falResponse.status);
    
    let falData: any = null;
    
    try {
      falData = JSON.parse(falText);
    } catch {
      console.error('❌ Non-JSON response:', falText);
      return new Response(
        JSON.stringify({ error: `Invalid response from AI service: ${falText}` }),
        { status: 500, ...cors(origin) }
      );
    }
    
    if (!falResponse.ok) {
      console.error('❌ fal.ai error response:', falData);
      const errorMsg = falData.detail || falData.error || falData.message || JSON.stringify(falData);
      return new Response(
        JSON.stringify({ error: `AI service error: ${errorMsg}` }),
        { status: falResponse.status, ...cors(origin) }
      );
    }
    
    console.log('✅ fal.ai success response:', falData);
    
    // Extract request_id from response
    const requestId = falData.request_id || falData.id || falData.requestId;
    
    if (requestId) {
      return new Response(
        JSON.stringify({
          id: requestId,
          status: 'processing'
        }),
        { status: 200, ...cors(origin) }
      );
    }
    
    console.error('❌ No request_id in response:', falData);
    return new Response(
      JSON.stringify({ error: 'No request ID in response', debug: falData }),
      { status: 500, ...cors(origin) }
    );
    
  } catch (err: any) {
    console.error('❌ Server error:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Generation failed', stack: err.stack }),
      { status: 500, ...cors(origin) }
    );
  }
}
