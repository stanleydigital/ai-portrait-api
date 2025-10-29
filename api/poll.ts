export const config = { runtime: "edge" };

// --- Allow-list of origins that can call your API ---
const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com" // Shopify theme editor
]);

function corsWithOrigin(origin: string | null) {
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

// ---------- Helpers ----------
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

async function uploadResultToCloudinary(fileUrl: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET!;
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

  const fd = new FormData();
  fd.append("file", fileUrl);          // remote URL from Replicate
  fd.append("upload_preset", preset);
  // Optional: fd.append("folder", "ai-previews");

  const r = await fetch(endpoint, { method: "POST", body: fd });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Cloudinary upload failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  return json.secure_url as string;    // stable CDN URL
}

// ---------- Main ----------
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...corsWithOrigin(origin) });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  }

  try {
    const { get_url } = await req.json();
    if (!get_url) {
      return new Response(JSON.stringify({ error: "Missing get_url" }), {
        status: 400, ...corsWithOrigin(origin)
      });
    }

    const r = await fetch(get_url, {
      headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}` }
    });

    const p = await r.json();

    // Still processing -> just relay status
    if (p.status !== "succeeded") {
      return new Response(JSON.stringify({ status: p.status || "processing" }), {
        status: 200, ...corsWithOrigin(origin)
      });
    }

    // Succeeded -> extract best URL from any output shape
    const replicateUrl = pickUrl(p.output);
    if (!replicateUrl) {
      return new Response(JSON.stringify({ status: "failed", error: "No output URL" }), {
        status: 200, ...corsWithOrigin(origin)
      });
    }

    // Upload final image to Cloudinary for stability
    let cdnUrl: string | null = null;
    try {
      cdnUrl = await uploadResultToCloudinary(replicateUrl);
    } catch (e) {
      // If Cloudinary upload fails, still return the Replicate URL so frontend can fall back
      console.warn("Cloudinary upload failed in poll:", e);
    }

    return new Response(
      JSON.stringify({
        status: "succeeded",
        result_url: replicateUrl, // original Replicate URL
        cdn_url: cdnUrl           // stable Cloudinary URL (preferred for display)
      }),
      { status: 200, ...corsWithOrigin(origin) }
    );

  } catch (err: any) {
    console.error("Poll server error:", err);
    return new Response(
      JSON.stringify({ error: "Server error", details: String(err) }),
      { status: 500, ...corsWithOrigin(origin) }
    );
  }
}
