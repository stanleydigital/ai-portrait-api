export const config = { runtime: "edge" };

// ------- Webhook handler for Replicate completion events -------
// This receives notifications when Replicate finishes generating
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

// Helper to find URL in Replicate output
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
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET!;
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  
  const fd = new FormData();
  fd.append("file", fileUrl);
  fd.append("upload_preset", preset);
  fd.append("public_id", `results/${predictionId}`);
  fd.append("overwrite", "false");
  
  const r = await fetch(endpoint, { method: "POST", body: fd });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Cloudinary upload failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  return json.secure_url as string;
}

export default async function handler(req: Request) {
  // Only accept POST requests from Replicate
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  
  try {
    const body = await req.json();
    
    console.log("🎣 Webhook received:", {
      id: body.id,
      status: body.status,
      hasOutput: !!body.output
    });
    
    const { id, status, output } = body;
    
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing prediction ID" }), { status: 400 });
    }
    
    // If generation succeeded, upload to Cloudinary immediately
    if (status === "succeeded" && output) {
      const replicateUrl = pickUrl(output);
      
      if (replicateUrl) {
        try {
          const cdn_url = await uploadResultToCloudinary(replicateUrl, id);
          console.log("✅ Webhook: Uploaded to Cloudinary:", id);
          
          // Cache the result in KV for instant retrieval by polling endpoint
          const kvClient = await initKV();
          if (kvClient) {
            await kvClient.set(`prediction:${id}`, {
              status: "succeeded",
              cdn_url,
              output: [replicateUrl]
            }, { ex: 86400 }); // Cache for 24 hours
            
            // Also cache the CDN URL separately
            await kvClient.set(`cdn:${id}`, cdn_url, { ex: 604800 }); // 7 days
            
            console.log("✅ Webhook: Cached result:", id);
          }
        } catch (err) {
          console.error("❌ Webhook: Cloudinary upload failed:", err);
          // Don't fail the webhook - Replicate expects 200
        }
      }
    }
    
    // If generation failed, cache the error
    if (status === "failed" || status === "canceled") {
      const kvClient = await initKV();
      if (kvClient) {
        await kvClient.set(`prediction:${id}`, {
          status,
          error: body.error || null
        }, { ex: 3600 }); // Cache errors for 1 hour
        
        console.log("✅ Webhook: Cached error:", id);
      }
    }
    
    // Always return 200 to Replicate
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
    
  } catch (err: any) {
    console.error("❌ Webhook error:", err);
    // Still return 200 so Replicate doesn't retry
    return new Response(JSON.stringify({ error: err.message }), { status: 200 });
  }
}
