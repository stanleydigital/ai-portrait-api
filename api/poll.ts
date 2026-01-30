export const config = { runtime: "edge" };

// Allow-list of origins
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

// KV Storage
let kv: any = null;

async function initKV() {
  if (kv) return kv;
  
  try {
    // @ts-ignore
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    console.warn("⚠️ Vercel KV not available");
    return null;
  }
}

// Helper: recursively find a URL in output
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

// Cloudinary upload helper with CACHING
async function uploadResultToCloudinary(fileUrl: string, predictionId: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET!;
  
  // Check cache first to avoid duplicate uploads
  const kvClient = await initKV();
  if (kvClient) {
    const cacheKey = `cdn:${predictionId}`;
    const cached = await kvClient.get(cacheKey);
    if (cached) {
      console.log("✅ Using cached Cloudinary URL:", predictionId);
      return cached as string;
    }
  }
  
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  
  const fd = new FormData();
  fd.append("file", fileUrl);
  fd.append("upload_preset", preset);
  fd.append("public_id", `valentine-results/${predictionId}`);
  
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
    console.log("✅ Cached Cloudinary URL:", predictionId);
  }
  
  return cdnUrl;
}

// Poll fal.ai by request ID
async function pollFalAI(requestId: string) {
  // Check webhook cache first
  const kvClient = await initKV();
  if (kvClient) {
    const cached = await kvClient.get(`prediction:${requestId}`);
    if (cached) {
      console.log("⚡ Using webhook cache:", requestId);
      return cached as any;
    }
  }
  
  // Poll fal.ai status endpoint
  const statusUrl = `https://queue.fal.run/fal-ai/qwen-image-edit-2511/lora/requests/${requestId}/status`;
  
  const r = await fetch(statusUrl, {
    headers: { 
      "Authorization": `Key ${process.env.FAL_API_KEY}`
    }
  });
  
  if (!r.ok) {
    const txt = await r.text();
    console.error('❌ fal.ai status check failed:', r.status, txt);
    return { 
      status: "failed" as const, 
      id: requestId, 
      error: `fal.ai status check failed: ${r.status}` 
    };
  }
  
  const statusData = await r.json();
  
  console.log('📊 fal.ai status:', statusData);
  
  const status = (statusData.status || "").toLowerCase();
  
  // If still in queue or processing
  if (status === "in_queue" || status === "in_progress") {
    return { 
      status: "processing" as const, 
      id: requestId 
    };
  }
  
  // If completed, fetch the result
  if (status === "completed") {
    const resultUrl = `https://queue.fal.run/fal-ai/qwen-image-edit-2511/lora/requests/${requestId}`;
    
    const resultRes = await fetch(resultUrl, {
      headers: { 
        "Authorization": `Key ${process.env.FAL_API_KEY}`
      }
    });
    
    if (!resultRes.ok) {
      const txt = await resultRes.text();
      console.error('❌ fal.ai result fetch failed:', resultRes.status, txt);
      return { 
        status: "failed" as const, 
        id: requestId, 
        error: `Failed to fetch result: ${resultRes.status}` 
      };
    }
    
    const resultData = await resultRes.json();
    
    console.log('🎉 fal.ai result:', resultData);
    
    // Extract image URL from fal.ai response
    // Response format: { images: [{ url: "...", width: 800, height: 1120 }] }
    let falUrl: string | null = null;
    
    if (resultData.images && resultData.images[0]) {
      falUrl = resultData.images[0].url;
    }
    
    if (!falUrl) {
      console.error('❌ No image URL in result:', resultData);
      return { 
        status: "failed" as const, 
        id: requestId, 
        error: "No image in result" 
      };
    }
    
    // Upload to Cloudinary
    let cdn_url: string | null = null;
    
    try {
      cdn_url = await uploadResultToCloudinary(falUrl, requestId);
      console.log("✅ Uploaded to Cloudinary:", requestId);
    } catch (e) {
      console.warn("Cloudinary upload failed (fallback to fal.ai URL):", e);
    }
    
    const result = {
      status: "succeeded" as const,
      id: requestId,
      output: [falUrl],
      cdn_url
    };
    
    // Cache for future requests
    if (kvClient) {
      await kvClient.set(`prediction:${requestId}`, result, { ex: 86400 });
    }
    
    return result;
  }
  
  // If failed
  if (status === "failed" || status === "error") {
    const result = { 
      status: "failed" as const, 
      id: requestId, 
      error: statusData.error || "Generation failed" 
    };
    
    // Cache errors too
    if (kvClient) {
      await kvClient.set(`prediction:${requestId}`, result, { ex: 3600 });
    }
    
    return result;
  }
  
  // Unknown status
  console.warn('⚠️ Unknown fal.ai status:', status);
  return { 
    status: "processing" as const, 
    id: requestId 
  };
}

// Main handler
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...corsWithOrigin(origin) });
  }
  
  try {
    if (req.method === "GET") {
      const { searchParams } = new URL(req.url);
      const id = searchParams.get("id");
      
      if (!id) {
        return new Response(
          JSON.stringify({ error: "Missing id parameter" }), 
          { status: 400, ...corsWithOrigin(origin) }
        );
      }
      
      const data = await pollFalAI(id);
      return new Response(
        JSON.stringify(data), 
        { status: 200, ...corsWithOrigin(origin) }
      );
    }
    
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const requestId: string | undefined = body.request_id || body.id;
      
      if (!requestId) {
        return new Response(
          JSON.stringify({ error: "Missing request_id or id" }), 
          { status: 400, ...corsWithOrigin(origin) }
        );
      }
      
      const data = await pollFalAI(requestId);
      return new Response(
        JSON.stringify(data), 
        { status: 200, ...corsWithOrigin(origin) }
      );
    }
    
    return new Response(
      "Method not allowed", 
      { status: 405, ...corsWithOrigin(origin) }
    );
    
  } catch (err: any) {
    console.error("Poll server error:", err);
    return new Response(
      JSON.stringify({ status: "processing" }), 
      { status: 200, ...corsWithOrigin(origin) }
    );
  }
}
