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
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
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
          "POST JSON { imageUrl or image_url, prompt or style } — fixed size 3072x4096 is applied on the server."
      }),
      { status: 200, ...corsWithOrigin(origin) }
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, ...corsWithOrigin(origin) });
  }

  try {
    const body = await req.json().catch(() => ({} as any));

    // Accept both camelCase and snake_case from the client
    const image_url: string | undefined = body.image_url || body.imageUrl;
    const rawPrompt: string | undefined = body.prompt ?? body.style;

    if (!image_url) {
      return new Response(JSON.stringify({ error: "Missing image_url" }), {
        status: 400,
        ...corsWithOrigin(origin)
      });
    }

    // Build Seedream-4 input: must be image_url; fix size to 3072x4096
    const input: Record<string, any> = {
      image_url,
      prompt: `${(rawPrompt || "").trim()} Preserve the exact identity from the uploaded photo (same markings, colors, and features).`.trim(),
      size: "custom",
      width: 3072,
      height: 4096
    };

    // Start prediction (async; client will poll /api/poll with the returned id)
    const url = "https://api.replicate.com/v1/models/bytedance/seedream-4/predictions";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Replicate expects "Token", not "Bearer"
        "Authorization": `Token ${process.env.REPLICATE_API_TOKEN}`
      },
      body: JSON.stringify({ input })
    });

    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch {}

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

    // Bubble up Replicate's error so the preview page can display it
    const errMsg = data?.error || text || `Replicate error ${res.status}`;
    return new Response(JSON.stringify({ error: errMsg }), {
      status: res.status || 500,
      ...corsWithOrigin(origin)
    });

  } catch (err: any) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: err?.message || "preview_failed" }), {
      status: 500,
      ...corsWithOrigin(origin)
    });
  }
}
