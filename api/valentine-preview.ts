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

// Rate limiting with Vercel KV
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

// Fallback in-memory rate limiting
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

export default async function handler(req: Request) {
  const origin = req.headers.get("origin");
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...cors(origin) });
  }
  
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...cors(origin) });
  }
  
  try {
    // Rate limiting: 50 generations per hour per IP
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || "unknown";
    
    if (!await checkRateLimit(ip, 50, 3600000)) {
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded. You can generate 50 portraits per hour. Please try again later."
        }),
        { status: 429, ...cors(origin) }
      );
    }
    
    const body = await req.json().catch(() => ({}));
    
    // Get both image URLs and prompt
    const templateUrl: string | undefined = body.templateUrl;
    const userPhotoUrl: string | undefined = body.userPhotoUrl;
    const prompt: string = (body.prompt || "").trim();
    
    console.log('📥 Valentine request received:');
    console.log('  Template URL:', templateUrl);
    console.log('  User photo URL:', userPhotoUrl);
    console.log('  Prompt length:', prompt.length);
    
    // Validate both images present
    if (!templateUrl || !userPhotoUrl) {
      return new Response(
        JSON.stringify({ error: "Missing templateUrl or userPhotoUrl" }),
        { status: 400, ...cors(origin) }
      );
    }
    
    // Validate image URLs
    try {
      new URL(templateUrl);
      new URL(userPhotoUrl);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid image URL format" }),
        { status: 400, ...cors(origin) }
      );
    }
    
    // CRITICAL: Image order matters!
    // image_urls[0] = base image (template)
    // image_urls[1] = source image (user photo with head to swap)
    const imageUrls = [templateUrl, userPhotoUrl];
    
    console.log('📤 Calling fal.ai with image_urls:', imageUrls);
    
    // Call fal.ai queue API
    const falResponse = await fetch('https://queue.fal.run/fal-ai/qwen-image-edit-2511/lora', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${process.env.FAL_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        image_urls: imageUrls,        // Array of both images
        prompt: prompt,
        image_size: {
          width: 800,                  // Or 845 based on your decision
          height: 1120
        },
        num_inference_steps: 20,
        guidance_scale: 2.0,
        num_images: 1,
        enable_safety_checker: false,
        output_format: "png"
      })
    });
    
    const falText = await falResponse.text();
    let falData: any = null;
    
    try {
      falData = JSON.parse(falText);
    } catch {
      console.error('❌ Non-JSON response from fal.ai:', falText);
      return new Response(
        JSON.stringify({ error: 'Invalid response from AI service' }),
        { status: 500, ...cors(origin) }
      );
    }
    
    if (!falResponse.ok) {
      console.error('❌ fal.ai error:', falData);
      return new Response(
        JSON.stringify({ error: falData.detail || falData.error || 'AI generation failed' }),
        { status: falResponse.status, ...cors(origin) }
      );
    }
    
    console.log('✅ fal.ai response:', falData);
    
    // fal.ai queue returns request_id
    if (falData.request_id) {
      return new Response(
        JSON.stringify({
          id: falData.request_id,
          status: 'processing'
        }),
        { status: 200, ...cors(origin) }
      );
    }
    
    // Unknown response format
    console.error('❌ Unexpected fal.ai response format:', falData);
    return new Response(
      JSON.stringify({ error: 'Unexpected response format from AI service' }),
      { status: 500, ...cors(origin) }
    );
    
  } catch (err: any) {
    console.error('❌ Server error:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Generation failed' }),
      { status: 500, ...cors(origin) }
    );
  }
}
