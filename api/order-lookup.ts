export const config = { runtime: "edge" };

const ALLOWED_ORIGINS = new Set([
  "https://pawinci.com",
  "https://www.pawinci.com",
  "https://pawincistore.myshopify.com"
]);

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    headers: {
      "Content-Type": "application/json",
      ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
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
    console.warn("KV not available");
    return null;
  }
}

export default async function handler(req: Request) {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, ...cors(origin) });
  }

  if (req.method !== "GET") {
    return new Response("Method not allowed", { 
      status: 405, 
      ...cors(origin) 
    });
  }

  try {
    const kvClient = await initKV();
    if (!kvClient) {
      return new Response(JSON.stringify({ 
        error: "Storage unavailable" 
      }), {
        status: 500,
        ...cors(origin)
      });
    }

    const { searchParams } = new URL(req.url);
    const orderNumber = searchParams.get("order");
    const email = searchParams.get("email");

    if (!orderNumber && !email) {
      return new Response(JSON.stringify({ 
        error: "Missing order number or email" 
      }), {
        status: 400,
        ...cors(origin)
      });
    }

    let orderData = null;

    if (orderNumber) {
      const key = `order:${orderNumber}`;
      orderData = await kvClient.get(key);
      
      if (orderData) {
        console.log("Found order by number:", orderNumber);
      }
    }

    if (!orderData && email) {
      const emailKey = `order:email:${email.toLowerCase()}`;
      const foundOrderNumbers = await kvClient.get(emailKey);
      
      if (foundOrderNumbers) {
        console.log("Found orders by email:", email, foundOrderNumbers);
        
        // Handle multiple orders
        if (Array.isArray(foundOrderNumbers)) {
          // Get all orders for this email
          const orders = [];
          for (const orderNum of foundOrderNumbers) {
            const orderKey = `order:${orderNum}`;
            const order = await kvClient.get(orderKey);
            if (order) {
              orders.push(order);
            }
          }
          
          if (orders.length > 0) {
            // Return all orders
            return new Response(JSON.stringify({
              ok: true,
              multiple: true,
              orders: orders,
              count: orders.length
            }), {
              status: 200,
              ...cors(origin)
            });
          }
        } else {
          // Legacy: single order number (for backward compatibility)
          const orderKey = `order:${foundOrderNumbers}`;
          orderData = await kvClient.get(orderKey);
          
          if (orderData) {
            console.log("Found single order by email:", email);
          }
        }
      }
    }

    if (!orderData) {
      console.log("Order not found:", { orderNumber, email });
      return new Response(JSON.stringify({ 
        error: "Order not found",
        message: "This order doesn't exist or doesn't contain any portraits. Please check your order number and try again."
      }), {
        status: 404,
        ...cors(origin)
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      order: orderData
    }), {
      status: 200,
      ...cors(origin)
    });

  } catch (err: any) {
    console.error("Order lookup error:", err);
    return new Response(JSON.stringify({ 
      error: "Lookup failed",
      message: err.message || "Internal error"
    }), {
      status: 500,
      ...cors(origin)
    });
  }
}
