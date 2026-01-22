export const config = { runtime: "edge" };

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

export default async function handler(req: Request) {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  
  try {
    const body = await req.json();
    
    console.log("Webhook received:", JSON.stringify(body));
    
    // fal.ai webhook structure: { request_id, status: "OK"|"ERROR", payload }
    const { request_id, status, payload } = body;
    
    if (!request_id) {
      console.error("Missing request_id in webhook");
      return new Response(JSON.stringify({ error: "Missing request ID" }), { status: 400 });
    }
    
    // If generation succeeded (status: "OK")
    if (status === "OK" && payload) {
      console.log("Webhook payload:", JSON.stringify(payload));
      
      let falImageUrl = null;
      
      // Try multiple possible locations for the image URL
      if (payload.images?.[0]?.url) {
        falImageUrl = payload.images[0].url;
      } else if (payload.response?.images?.[0]?.url) {
        falImageUrl = payload.response.images[0].url;
      } else {
        falImageUrl = pickUrl(payload);
      }
      
      console.log("Extracted webhook image URL:", falImageUrl);
      
      if (falImageUrl) {
        try {
          const cdn_url = await uploadResultToCloudinary(falImageUrl, request_id);
          console.log("Webhook: Uploaded to Cloudinary:", request_id, cdn_url);
          
          const kvClient = await initKV();
          if (kvClient) {
            await kvClient.set(`prediction:${request_id}`, {
              status: "succeeded",
              cdn_url,
              output: [falImageUrl]
            }, { ex: 86400 });
            
            await kvClient.set(`cdn:${request_id}`, cdn_url, { ex: 604800 });
            
            console.log("Webhook: Cached result:", request_id);
          }
        } catch (err) {
          console.error("Webhook: Cloudinary upload failed:", err);
        }
      } else {
        console.error("Webhook: No image URL found in payload!");
      }
    }
    
    // If generation failed (status: "ERROR")
    if (status === "ERROR") {
      console.error("Webhook: Generation failed:", body.error);
      const kvClient = await initKV();
      if (kvClient) {
        await kvClient.set(`prediction:${request_id}`, {
          status: "failed",
          error: body.error || payload?.detail || "Generation failed"
        }, { ex: 3600 });
        
        console.log("Webhook: Cached error:", request_id);
      }
    }
    
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
    
  } catch (err: any) {
    console.error("Webhook error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 200 });
  }
}
