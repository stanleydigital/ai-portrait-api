export const config = { runtime: "edge" };

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
    return new Response(JSON.stringify({ ok: true, hint: "POST JSON with image_url + style" }), { status: 200, ...cors() });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, ...cors() });

  try {
    const { image_url, style } = await req.json();
    if (!image_url) {
      return new Response(JSON.stringify({ error: "Missing image_url" }), { status: 400, ...cors() });
    }

    const body = {
      model: "bytedance/seedream-4",
      input: {
        image: image_url,
        width: 4096,
        height: 4096,
        prompt: `${style || ""} Create a flattering portrait, maintain identity from the reference image.`.trim()
      }
    };

    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Prefer": "wait=60"
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep as text */ }

    if (res.ok && data?.status === "succeeded" && data?.output?.[0]) {
      return new Response(JSON.stringify({ result_url: data.output[0] }), { status: 200, ...cors() });
    }
    if (data?.urls?.get) {
      return new Response(JSON.stringify({ get_url: data.urls.get }), { status: 202, ...cors() });
    }

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
