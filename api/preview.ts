export const config = { runtime: "edge" };

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
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    }
  };
}

// --- Helpers ---
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

// Uploads a remote image URL to Cloudinary and returns a stable secure_url
async function uploadResultToCloudinary(fileUrl: string): Promise<string> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME!;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET!;
  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

  const fd = new FormData();
  fd.append("file", fileUrl);
  fd.append("upload_preset", preset);

  const r = await fetch(endpoint, { method: "POST", body: fd });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Cloudinary upload failed: ${r.status} ${txt}`);
  }
  const json = await r.json();
  return json.secure_url as string;
}

// --- Main handler ---
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...corsWithOrigin(origin) });
  }

  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ ok: true, hint: "POST JSON { image_url, style }" }),
      { status: 200, ...corsWithOrigin(origin) }
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  }

  try {
    const { image_url, style } = await req.json();
    if (!image_url) {
      return new Response(JSON.stringify({ error: "Missing image_url" }), {
        status: 400,
        ...corsWithOrigin(origin)
      });
    }

    // ✅ Seedream 4: correct input format
    const input: Record<string, any> = {
      prompt: `${(style || "").trim()} Preserve the exact identity from the uploaded photo (same markings, colors, and features).`,
      image_input: [image_url],
      size: "4K"
    };

    const url = "https://api.replicate.com/v1/models/bytedance/seedream-4/predictions";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Prefer": "wait=60"
      },
      body: JSON.stringify({ input })
    });

    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch {}

    // If it finished within the wait window, handle it immediately
    if (res.ok && data?.status === "succeeded") {
      const replicateUrl = pickUrl(data.output);
      if (replicateUrl) {
        let cdnUrl: string | null = null;
        try { cdnUrl = await uploadResultToCloudinary(replicateUrl); } catch (err) {
          console.warn("Cloudinary upload failed, continuing with Replicate URL:", err);
        }
        return new Response(
          JSON.stringify({ result_url: replicateUrl, cdn_url: cdnUrl }),
          { status: 200, ...corsWithOrigin(origin) }
        );
      }
    }

    // If still processing, return GET URL for polling
    if (data?.urls?.get) {
      return new Response(
        JSON.stringify({ get_url: data.urls.get, status: data.status || "processing" }),
        { status: 202, ...corsWithOrigin(origin) }
      );
    }

    console.error("Replicate error:", res.status, text);
    return new Response(JSON.stringify({
      error: "Replicate error",
      status: res.status,
      details: text
    }), { status: 500, ...corsWithOrigin(origin) });

  } catch (err: any) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: "Server error", details: String(err) }), {
      status: 500, ...corsWithOrigin(origin)
    });
  }
}
