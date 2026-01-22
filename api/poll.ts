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

function corsWithOrigin(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    headers: {
      "Content-Type": "application/json",
      ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  };
}

// ------- KV Storage -------
let kv: any = null;

async function initKV() {
  if (kv) return kv;
  
  try {
    // @ts-ignore
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    console.warn("uc0u9888 u65039  Vercel KV not available");
    return null;
  }
}

// ------- Helper: recursively find a URL in Replicate output -------
function pickUrl(output: any): string | null {
  if (!output) return null;
  if (typeof output === "string" && /^https?:///.test(output)) return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const u = pickUrl(item);
      if (u) return u;
    }
  } else if (typeof output === "object") {
    for (const v of Object.values(output)) {
      const u = pickUrl(v);
      if (u) return u;
    }
  }
  return null;
}

// ------- Cloudinary upload helper with CACHING -------
async function uploadResultToCloudinary(fileUrl: string, predictionId: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const apiKey = process.env.CLOUDINARY_API_KEY!;
  const apiSecret = process.env.CLOUDINARY_API_SECRET!;
  
  // Check cache first to avoid duplicate uploads
  const kvClient = await initKV();
  if (kvClient) {
    const cacheKey = `cdn:${predictionId}`;
    const cached = await kvClient.get(cacheKey);
    if (cached) {
      console.log("uc0u9989  Using cached Cloudinary URL:", predictionId);
      return cached as string;
    }
  }
  
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `results/${predictionId}`;
  
  // Generate signature for signed upload
  const paramsToSign: Record<string, any> = {
    timestamp,
    public_id: publicId,
    folder: "results"
  };
  
  const sortedParams = Object.keys(paramsToSign)
    .sort()
    .map(key => `${key}=${paramsToSign[key]}`)
    .join("&");
  
  const stringToSign = sortedParams + apiSecret;
  const msgUint8 = new TextEncoder().encode(stringToSign);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  
  const fd = new FormData();
  fd.append("file", fileUrl);
  fd.append("api_key", apiKey);
  fd.append("timestamp", timestamp.toString());
  fd.append("signature", signature);
  fd.append("public_id", publicId);
  fd.append("folder", "results");
  
  const r = await fetch(endpoint, { method: "POST", body: fd });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Cloudinary upload failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  const cdnUrl = json.secure_url as string;
  
  // Cache the result for 7 days
  if (kvClient) {
    await kvClient.set(`cdn:${predictionId}`, cdnUrl, { ex: 604800 });
    console.log("uc0u9989  Cached Cloudinary URL:", predictionId);
  }
  
  return cdnUrl;
}

// ------- Poll helpers with webhook cache check -------
async function pollById(id: string, debug = false) {
  // OPTIMIZATION: Check webhook cache first
  const kvClient = await initKV();
  if (kvClient) {
    const cached = await kvClient.get(`prediction:${id}`);
    if (cached) {
      console.log("uc0u9889  Using webhook cache:", id);
      return cached as any;
    }
  }
  
  // If not in cache, poll fal.ai
  const r = await fetch(`https://queue.fal.run/fal-ai/qwen-image-edit-2511/lora/requests/${id}/status`, {
    headers: { 
      "Authorization": `Key ${process.env.FAL_API_KEY}`,
      "Content-Type": "application/json"
    }
  });
  
  if (!r.ok) {
    const txt = await r.text();
    return { status: "failed" as const, id, error: `fal.ai fetch failed: ${r.status} ${txt}` };
  }
  
  const pred = await r.json();
  
  if (debug) {
    return { status: pred.status, raw: pred };
  }
  
  // fal.ai uses uppercase status: "IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED"
  const status = pred.status;
  
  if (status === "COMPLETED") {
    // fal.ai returns images array in response_data
    const imageUrl = pred.response_data?.images?.[0]?.url || pickUrl(pred.response_data);
    let cdn_url: string | null = null;
    
    if (imageUrl) {
      try {
        cdn_url = await uploadResultToCloudinary(imageUrl, id);
        console.log("uc0u9989  Uploaded to Cloudinary:", id);
      } catch (e) {
        console.warn("Cloudinary upload failed (fallback to fal.ai URL):", e);
      }
    }
    
    const result = {
      status: "succeeded" as const,
      id,
      output: imageUrl ? [imageUrl] : [],
      cdn_url
    };
    
    // Cache for future requests
    if (kvClient) {
      await kvClient.set(`prediction:${id}`, result, { ex: 86400 });
    }
    
    return result;
  }
  
  if (status === "FAILED") {
    const result = { 
      status: "failed" as const, 
      id, 
      error: pred.error || pred.logs || "Generation failed" 
    };
    
    // Cache errors too
    if (kvClient) {
      await kvClient.set(`prediction:${id}`, result, { ex: 3600 });
    }
    
    return result;
  }
  
  // Still processing (IN_QUEUE or IN_PROGRESS)
  return { status: "processing" as const, id };
}


async function pollByGetUrl(get_url: string, debug = false) {
  // fal.ai doesn't use get_url pattern - this function is kept for backward compatibility
  // but will just return an error since fal.ai polling is done by ID only
  return { 
    status: "failed" as const, 
    error: "get_url not supported with fal.ai - use polling by ID instead" 
  };
}

// ------- Main handler -------
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...corsWithOrigin(origin) });
  }
  
  try {
    if (req.method === "GET") {
      const { searchParams } = new URL(req.url);
      const id = searchParams.get("id");
      const debug = searchParams.get("debug") === "1";
      
      if (!id) {
        const get_url = searchParams.get("get_url");
        if (!get_url) {
          return new Response(JSON.stringify({ error: "Missing id" }), {
            status: 200, ...corsWithOrigin(origin)
          });
        }
        const data = await pollByGetUrl(get_url, debug);
        return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
      }
      
      const data = await pollById(id, debug);
      return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
    }
    
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const get_url: string | undefined = body.get_url;
      const debug = body.debug === true;
      if (!get_url) {
        return new Response(JSON.stringify({ error: "Missing get_url" }), {
          status: 200, ...corsWithOrigin(origin)
        });
      }
      const data = await pollByGetUrl(get_url, debug);
      return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
    }
    
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  } catch (err: any) {
    console.error("Poll server error:", err);
    return new Response(JSON.stringify({ status: "processing" }), {
      status: 200, ...corsWithOrigin(origin)
    });
  }
}}
