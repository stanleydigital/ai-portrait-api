export const config = { runtime: "edge" };

// Replace with your real Shopify storefront domain
function cors() {
  return {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://pawincistore.myshopify.com",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  };
}

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, ...cors() });
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ ok: true, hint: "POST JSON { image_url, style }" }),
      { status: 200, ...cors() }
    );
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, ...cors() });

  try {
    const { image_url, style } = await req.json();
    if (!image_url) {
      return new Response(JSON.stringify({ error: "Missing image_url" }), { status: 400, ...cors() });
    }

    // Build inputs for Seedream 4. Start minimal to avoid schema mismatches.
    // If the model supports width/height, you can uncomment and adjust.
    const input: Record<string, any> = {
      image: image_url,
      prompt: `${style || ""} Create a flattering portrait, maintain identity from the reference image.`.trim(),
      // width: 4096,
      // height: 4096
    };

    // IMPORTANT: Use the model endpoint so we don't need a version in the body
    const url = "https://api.replicate.com/v1/models/bytedance/seedream-4/predictions";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Prefer": "wait=60"
      },
      body: JSON.stringify({ input }) // NOTE: no model, no version here
    });

    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep as text for error visibility */ }

    // If it finished within the wait window, return the result
    if (res.ok && data?.status === "succeeded" && data?.output?.[0]) {
      return new Response(JSON.stringify({ result_url: data.output[0] }), { status: 200, ...cors() });
    }

    // If still processing, return the GET url so your /api/poll can check it
    if (data?.urls?.get) {
      return new Response(JSON.stringify({ get_url: data.urls.get }), { status: 202, ...cors() });
    }

    // Bubble up the real error from Replicate so we can see what's wrong
    console.error("Replicate error:", res.status, text);
    return new Response(JSON.stringify({ error: "Replicate error", status: res.status, details: text }), {
      status: 500, ...cors()
    });

  } catch (err: any) {
    console.error("Server error:", err);
    return new Response(JSON.stringify({ error: "Server error", details: String(err) }), {
      status: 500, ...cors()
    });
  }
}
