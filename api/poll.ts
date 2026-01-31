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
    console.warn("Vercel KV not available");
    return null;
  }
}

async function uploadResultToCloudinary(fileUrl: string, predictionId: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET!;
  
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
  
  if (kvClient) {
    await kvClient.set(`cdn:${predictionId}`, cdnUrl, { ex: 604800 });
    console.log("Cached Cloudinary URL:", predictionId);
  }
  
  return cdnUrl;
}

async function pollFalAI(requestId: string) {
  const kvClient = await initKV();
  if (kvClient) {
    const cached = await kvClient.get(`prediction:${requestId}`);
    if (cached) {
      console.log("Using webhook cache:", requestId);
      return cached as any;
    }
  }
  
  const statusUrl = `https://queue.fal.run/workflows/stanrazvanneugen/cards/requests/${requestId}/status`;
  
  const statusRes = await fetch(statusUrl, {
    headers: { 
      "Authorization": `Key ${process.env.FAL_API_KEY}`
    }
  });
  
  if (!statusRes.ok) {
    const txt = await statusRes.text();
    console.error("fal.ai status check failed:", statusRes.status, txt);
    
    if (statusRes.status === 404) {
      return { 
        status: "failed" as const, 
        id: requestId,
        error: "Request not found or expired"
      };
    }
    
    return { 
      status: "failed" as const, 
      id: requestId, 
      error: `fal.ai status check failed: ${statusRes.status}` 
    };
  }
  
  const statusData = await statusRes.json();
  
  console.log("fal.ai status:", statusData);
  
  const status = (statusData.status || "").toUpperCase();
  
  if (status === "IN_QUEUE" || status === "IN_PROGRESS") {
    return { 
      status: "processing" as const, 
      id: requestId 
    };
  }
  
  if (status === "COMPLETED") {
    const resultUrl = `https://queue.fal.run/workflows/stanrazvanneugen/cards/requests/${requestId}`;
    
    const resultRes = await fetch(resultUrl, {
      headers: { 
        "Authorization": `Key ${process.env.FAL_API_KEY}`
      }
    });
    
    if (!resultRes.ok) {
      const txt = await resultRes.text();
      console.error("fal.ai result fetch failed:", resultRes.status, txt);
      return { 
        status: "failed" as const, 
        id: requestId, 
        error: `Failed to fetch result: ${resultRes.status}` 
      };
    }
    
    const resultData = await resultRes.json();
    
    console.log("fal.ai result:", resultData);
    
    let falUrl: string | null = null;
    
    // Handle both direct model response and workflow response
if (resultData.image && resultData.image.url) {
  // Workflow output format (single image)
  falUrl = resultData.image.url;
} else if (resultData.images && resultData.images[0]) {
  // Direct model output format (array of images)
  falUrl = resultData.images[0].url;
}
    
    if (!falUrl) {
      console.error("No image URL in result:", resultData);
      return { 
        status: "failed" as const, 
        id: requestId, 
        error: "No image in result" 
      };
    }
    
    let cdn_url: string | null = null;
    
    try {
      cdn_url = await uploadResultToCloudinary(falUrl, requestId);
      console.log("Uploaded to Cloudinary:", requestId);
    } catch (e) {
      console.warn("Cloudinary upload failed:", e);
    }
    
    const result = {
      status: "succeeded" as const,
      id: requestId,
      output: [falUrl],
      cdn_url
    };
    
    if (kvClient) {
      await kvClient.set(`prediction:${requestId}`, result, { ex: 86400 });
    }
    
    return result;
  }
  
  if (status === "FAILED" || status === "ERROR") {
    const result = { 
      status: "failed" as const, 
      id: requestId, 
      error: statusData.error || "Generation failed" 
    };
    
    if (kvClient) {
      await kvClient.set(`prediction:${requestId}`, result, { ex: 3600 });
    }
    
    return result;
  }
  
  console.warn("Unknown fal.ai status:", status);
  return { 
    status: "processing" as const, 
    id: requestId 
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
