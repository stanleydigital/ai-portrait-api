export const config = { runtime: "edge" };

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

let kv: any = null;

async function initKV() {
  if (kv) return kv;
  try {
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    console.warn("KV not available");
    return null;
  }
}

function pickUrl(output: any): string | null {
  if (!output) return null;
  if (typeof output === "string" && /^https?:\/\//.test(output)) return output;
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

async function uploadResultToCloudinary(fileUrl: string, predictionId: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const apiKey = process.env.CLOUDINARY_API_KEY!;
  const apiSecret = process.env.CLOUDINARY_API_SECRET!;
  
  const kvClient = await initKV();
  if (kvClient) {
    const cacheKey = `cdn:${predictionId}`;
    const cached = await kvClient.get(cacheKey);
    if (cached) {
      console.log("Using cached Cloudinary URL:", predictionId);
      return cached as string;
    }
  }
  
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `results/${predictionId}`;
  
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
  
  if (kvClient) {
    await kvClient.set(`cdn:${predictionId}`, cdnUrl, { ex: 604800 });
    console.log("Cached Cloudinary URL:", predictionId);
  }
  
  return cdnUrl;
}

async function pollById(id: string, debug = false) {
  const kvClient = await initKV();
  if (kvClient) {
    const cached = await kvClient.get(`prediction:${id}`);
    if (cached) {
      console.log("Using webhook cache:", id);
      return cached as any;
    }
  }
  
  // CORRECT fal.ai status endpoint format
  const statusUrl = `https://queue.fal.run/fal-ai/qwen-image-edit-2511/lora/requests/${id}/status`;
  
  const r = await fetch(statusUrl, {
    method: "GET",
    headers: { 
      "Authorization": `Key ${process.env.FAL_API_KEY}`,
      "Content-Type": "application/json"
    }
  });
  
  if (!r.ok) {
    const txt = await r.text();
    console.error("fal.ai status fetch failed:", r.status, txt);
    return { status: "failed" as const, id, error: `fal.ai fetch failed: ${r.status} ${txt}` };
  }
  
  const pred = await r.json();
  
  if (debug) {
    return { status: pred.status, raw: pred };
  }
  
  console.log("fal.ai response:", {
    status: pred.status,
    hasResponse: !!pred.response,
    hasLogs: !!pred.logs
  });
  
  const status = pred.status;
  
  if (status === "COMPLETED") {
    // fal.ai returns result in "response" field, not "response_data"
    const imageUrl = pred.response?.images?.[0]?.url || pickUrl(pred.response);
    let cdn_url: string | null = null;
    
    if (imageUrl) {
      try {
        cdn_url = await uploadResultToCloudinary(imageUrl, id);
        console.log("Uploaded to Cloudinary:", id);
      } catch (e) {
        console.warn("Cloudinary upload failed:", e);
      }
    }
    
    const result = {
      status: "succeeded" as const,
      id,
      output: imageUrl ? [imageUrl] : [],
      cdn_url
    };
    
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
    
    if (kvClient) {
      await kvClient.set(`prediction:${id}`, result, { ex: 3600 });
    }
    
    return result;
  }
  
  return { status: "processing" as const, id };
}

async function pollByGetUrl(get_url: string, debug = false) {
  return { 
    status: "failed" as const, 
    error: "get_url not supported" 
  };
}

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
        return new Response(JSON.stringify({ error: "Missing id" }), {
          status: 200, ...corsWithOrigin(origin)
        });
      }
      
      const data = await pollById(id, debug);
      return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
    }
    
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body.id;
      const debug = body.debug === true;
      
      if (!id) {
        return new Response(JSON.stringify({ error: "Missing id" }), {
          status: 200, ...corsWithOrigin(origin)
        });
      }
      
      const data = await pollById(id, debug);
      return new Response(JSON.stringify(data), { status: 200, ...corsWithOrigin(origin) });
    }
    
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  } catch (err: any) {
    console.error("Poll error:", err);
    return new Response(JSON.stringify({ status: "processing" }), {
      status: 200, ...corsWithOrigin(origin)
    });
  }
}
