export const config = { runtime: "edge" };

// ------- Webhook handler for fal.ai completion events -------
// This receives notifications when fal.ai finishes generating
// This eliminates the need for constant polling from the frontend

let kv: any = null;

async function initKV() {
  if (kv) return kv;
  
  try {
    // @ts-ignore
    const { kv: kvClient } = await import('@vercel/kv');
    kv = kvClient;
    return kv;
  } catch (err) {
    console.warn("⚠️ Vercel KV not available, webhook caching disabled");
    return null;
  }
}

// Helper to find URL in fal.ai output
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

// Upload to Cloudinary
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
      console.log("✅ Using cached Cloudinary URL:", predictionId);
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
    console.log("✅ Cached Cloudinary URL:", predictionId);
  }
  
  return cdnUrl;
}

export default async function handler(req: Request) {
  // Only accept POST requests from fal.ai
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  
  try {
    const body = await req.json();
    
    console.log("📥 Webhook received:", {
      request_id: body.request_id,
      status: body.status,
      hasResponseData: !!body.response_data
    });
    
    // fal.ai webhook payload: { request_id, status, response_data }
    const { request_id, status, response_data } = body;
    
    if (!request_id) {
      return new Response(JSON.stringify({ error: "Missing request ID" }), { status: 400 });
    }
    
    // If generation succeeded, upload to Cloudinary immediately
    if (status === "COMPLETED" && response_data) {
      const falImageUrl = response_data?.images?.[0]?.url || pickUrl(response_data);
      
      if (falImageUrl) {
        try {
          const cdn_url = await uploadResultToCloudinary(falImageUrl, request_id);
          console.log("✅ Webhook: Uploaded to Cloudinary:", request_id);
          
          // Cache the result in KV for instant retrieval by polling endpoint
          const kvClient = await initKV();
          if (kvClient) {
            await kvClient.set(`prediction:${request_id}`, {
              status: "succeeded",
              cdn_url,
              output: [falImageUrl]
            }, { ex: 86400 }); // Cache for 24 hours
            
            // Also cache the CDN URL separately
            await kvClient.set(`cdn:${request_id}`, cdn_url, { ex: 604800 }); // 7 days
            
            console.log("✅ Webhook: Cached result:", request_id);
          }
        } catch (err) {
          console.error("❌ Webhook: Cloudinary upload failed:", err);
          // Don't fail the webhook - fal.ai expects 200
        }
      }
    }
    
    // If generation failed, cache the error
    if (status === "FAILED") {
      const kvClient = await initKV();
      if (kvClient) {
        await kvClient.set(`prediction:${request_id}`, {
          status: "failed",
          error: body.error || body.logs || "Generation failed"
        }, { ex: 3600 }); // Cache errors for 1 hour
        
        console.log("✅ Webhook: Cached error:", request_id);
      }
    }
    
    // Always return 200 to fal.ai
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
    
  } catch (err: any) {
    console.error("❌ Webhook error:", err);
    // Still return 200 so fal.ai doesn't retry
    return new Response(JSON.stringify({ error: err.message }), { status: 200 });
  }
}
