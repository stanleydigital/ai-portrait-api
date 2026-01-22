cocoatextscaling0cocoaplatform0{fonttblf0fswissfcharset0 Helvetica;}
{colortbl;red255green255blue255;}
{*expandedcolortbl;;}
paperw11900paperh16840margl1440margr1440vieww11520viewh8400viewkind0
pardtx720tx1440tx2160tx2880tx3600tx4320tx5040tx5760tx6480tx7200tx7920tx8640pardirnaturalpartightenfactor0

f0fs24 cf0 export const config = { runtime: "edge" };

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
    console.warn("uc0u9888 u65039  Vercel KV not available, falling back to in-memory rate limiting");
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
    
    // OPTIMIZATION: Use Cloudinary transformations to optimize image before sending to fal.ai
    let optimizedImageUrl = imageUrl;
    if (/res.cloudinary.com/[^/]+/image/upload//.test(imageUrl)) {
      optimizedImageUrl = imageUrl.replace(
        "/upload/",
        "/upload/f_auto,q_auto,w_1024,h_1024,c_limit,q_85/"
      );
    }
    
    // Enhanced prompt for Valentine's card / head swap
    const finalPrompt = prompt || 
      `head_swap: start with Picture 1 as the base image, maintaining its lighting direction, shadows, and environmental atmosphere. 
             completely remove and replace the head from Picture 1 with the head from Picture 2.
             
             FACE PRESERVATION: strictly preserve every facial feature from Picture 2 - eye color, nose structure, lip shape, facial bone structure, skin texture.
             POSE TRANSFER: copy the exact eye direction, head tilt, rotation, and micro-expressions from Picture 1.
             SKIN HARMONY: adjust the body's skin tone to perfectly match the face's complexion - unified natural skin color throughout the entire person.
             BLENDING: seamless integration at the neck and shoulders with no visible edges or color discontinuity.
             
             QUALITY: photorealistic professional portrait photography, natural skin with visible pores and fine details,
             soft atmospheric lighting matching the original scene, professional color grading,
             ultra high resolution, hyper detailed, tack sharp focus, cinematic composition`;

    const negativePrompt = `artificial plastic skin, waxy doll-like appearance, mannequin quality, synthetic textures,
                     oversaturated unnatural colors, harsh visible edges at neck, visible seam line, 
                     color mismatch between face and body, two-toned skin appearance,
                     airbrushed overprocessed look, digital painting artifacts, unrealistic smoothness,
                     blurry soft focus, low resolution, amateur quality, photoshop artifacts,
                     mismatched lighting direction on face versus body, inconsistent shadows`;
    
    // --- Get webhook URL for this deployment ---
    const deploymentUrl = req.url.replace(//api/preview.*$/, "");
    const webhookUrl = `${deploymentUrl}/api/webhook`;
    
    // --- Call fal.ai with webhook ---
    const falUrl = "https://queue.fal.run/fal-ai/qwen-image-edit-2511/lora";
    
    const falRes = await fetch(falUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Key ${process.env.FAL_API_KEY}`
      },
      body: JSON.stringify({
        prompt: finalPrompt,
        image_urls: [optimizedImageUrl], // User's uploaded photo
        num_inference_steps: 28,
        guidance_scale: 4.5,
        num_images: 1,
        enable_safety_checker: true,
        output_format: "jpeg",
        acceleration: "regular",
        loras: [
          {
            path: "https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap/resolve/main/bfs_head_v5_2511_original.safetensors",
            scale: 0.6
          },
          {
            path: "https://huggingface.co/tlennon-ie/qwen-edit-skin/resolve/main/qwen-edit-skin.safetensors",
            scale: 0.7
          }
        ],
        negative_prompt: negativePrompt,
        webhook_url: webhookUrl
      })
    });
    
    const text = await falRes.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("Non-JSON response from fal.ai:", text);
    }
    
    // fal.ai returns { request_id } on successful queue submission
    if (falRes.ok && data?.request_id) {
      console.log("✅ fal.ai generation queued:", data.request_id);
      return new Response(
        JSON.stringify({
          id: data.request_id,
          status: "queued",
          get_url: null // fal.ai doesn't use get_url, we poll by ID
        }),
        { status: 200, ...cors(origin) }
      );
    }
    
    // --- Error: forward fal.ai's message to client ---
    const errMsg = data?.error || data?.detail || text || `fal.ai error ${falRes.status}`;
    console.error("fal.ai error:", errMsg);
    return new Response(JSON.stringify({ error: errMsg }), {
      status: falRes.status || 500,
      ...cors(origin)
    });
  } catch (err: any) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: err?.message || "preview_failed" }), {
      status: 500,
      ...cors(origin)
    });
  }
}}
