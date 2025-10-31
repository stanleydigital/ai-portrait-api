export const config = { runtime: "edge" };

// --- Allow-list of origins that can call your API ---
const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com" // keep for Shopify theme editor
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

// ---------- Main handler ----------
export default async function handler(req: Request) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...corsWithOrigin(origin) });
  }

  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: true,
        hint:
          "POST JSON { image_url, style, size?: '1K'|'2K'|'4K'|'custom', width?: 1024-4096, height?: 1024-4096, aspect_ratio?: 'match_input_image'|'1:1'|'16:9'|... }"
      }),
      { status: 200, ...corsWithOrigin(origin) }
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  }

  try {
    const body = await req.json();
    const image_url: string | undefined = body.image_url;
    const style: string | undefined = body.style;
    const sizeRaw: string | undefined = body.size;
    const widthRaw: number | string | undefined = body.width;
    const heightRaw: number | string | undefined = body.height;
    const aspect_ratio: string | undefined = body.aspect_ratio; // optional when size != 'custom'

    if (!image_url) {
      return new Response(JSON.stringify({ error: "Missing image_url" }), {
        status: 400,
        ...corsWithOrigin(origin)
      });
    }

    // Build Seedream input
    const clamp = (n: number) => Math.max(1024, Math.min(4096, Math.floor(n)));
    const hasWH = typeof widthRaw !== "undefined" || typeof heightRaw !== "undefined";
    const wantsCustom =
      (typeof sizeRaw === "string" && sizeRaw.toLowerCase() === "custom") || hasWH;

    const W = typeof widthRaw !== "undefined" ? clamp(Number(widthRaw)) : 4096;
    const H = typeof heightRaw !== "undefined" ? clamp(Number(heightRaw)) : 4096;

    const input: Record<string, any> = {
      prompt: `${(style || "").trim()} Preserve the exact identity from the uploaded photo (same markings, colors, and features).`,
      image_input: [image_url]
    };

    if (wantsCustom) {
      input.size = "custom";
      input.width = W;
      input.height = H;
    } else {
      // Default to 4K if not provided
      const normalized = String(sizeRaw || "4K").toUpperCase();
      input.size = normalized === "1K" || normalized === "2K" || normalized === "4K" ? normalized : "4K";
      // aspect_ratio is only used when size is NOT 'custom'
      if (typeof aspect_ratio === "string" && aspect_ratio.trim()) {
        input.aspect_ratio = aspect_ratio.trim();
      }
    }

    // Start prediction (ASYNC — no 60s wait; UI will poll /api/poll with the id)
    const url = "https://api.replicate.com/v1/models/bytedance/seedream-4/predictions";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // IMPORTANT: Replicate expects "Token", not "Bearer"
        "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`
      },
      body: JSON.stringify({ input })
    });

    const text = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      // leave data as null; we still return a polling-friendly shape below
    }

    // Return an id the client can poll, even if Replicate had a transient hiccup
    if (res.ok && data?.id) {
      return new Response(
        JSON.stringify({
          status: data.status || "queued",
          id: data.id,
          used_input: input
        }),
        { status: 200, ...corsWithOrigin(origin) }
      );
    }

    // Tolerant fallback: keep the client polling (don’t surface 5xx)
    console.error("Replicate create error:", res.status, text);
    return new Response(
      JSON.stringify({ status: "processing" }),
      { status: 200, ...corsWithOrigin(origin) }
    );

  } catch (err: any) {
    console.error("Server error:", err);
    // Keep the client in a pollable state on unexpected errors
    return new Response(
      JSON.stringify({ status: "processing" }),
      { status: 200, ...corsWithOrigin(origin) }
    );
  }
}
