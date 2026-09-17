/**
 * create-checkout-session.js
 * POST the cart here; it creates a Stripe Checkout session and returns the URL
 * to send the customer to for payment. Called by the "Place order" button.
 *
 * ── Required environment variable ──
 *   STRIPE_SECRET_KEY   From your Stripe dashboard (Developers -> API keys).
 *                        Use a "sk_test_..." key while testing, switch to
 *                        "sk_live_..." only once you're ready for real charges.
 *
 * ── Optional ──
 *   CURRENCY             Defaults to "aud". Lowercase 3-letter ISO code.
 *
 * ── What the front-end sends (JSON body) ──
 *   {
 *     "orderId": "W123",
 *     "cafeName": "Wunderbar Lunchbar",
 *     "customerName": "Sam",
 *     "phone": "0412 345 678",
 *     "pickupDay": "Today",
 *     "pickupTime": "12:30pm",
 *     "items": [
 *       { "name": "Breaky Wrap", "qty": 2, "unitPrice": 13.89, "selectionText": "Large" }
 *     ]
 *   }
 *
 * ── What it returns ──
 *   { "ok": true, "url": "https://checkout.stripe.com/..." }
 *   Redirect the browser to that URL (window.location.href = url).
 */

const { jsonResponse, corsHeaders, toStripeFormParams } = require('./_shared/lib');

const STRIPE_SESSIONS_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Use POST' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return jsonResponse(500, { ok: false, error: 'STRIPE_SECRET_KEY is not set.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { ok: false, error: 'Body must be valid JSON' });
  }

  const { customerName, phone, items, cafeName, orderId, pickupDay, pickupTime } = payload;

  if (!customerName || !phone || !Array.isArray(items) || items.length === 0) {
    return jsonResponse(400, { ok: false, error: 'customerName, phone, and a non-empty items array are required' });
  }
  for (const item of items) {
    if (!item.name || typeof item.unitPrice !== 'number' || typeof item.qty !== 'number' || item.qty < 1) {
      return jsonResponse(400, { ok: false, error: 'Each item needs a name, numeric unitPrice, and qty >= 1' });
    }
  }

  const currency = (process.env.CURRENCY || 'aud').toLowerCase();

  // Netlify passes the original request origin through in headers -- fall back
  // to constructing it from "host" if a browser or proxy doesn't send "origin".
  const origin = event.headers.origin || `https://${event.headers.host}`;

  const stripeBody = {
    mode: 'payment',
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
    line_items: items.map((item) => ({
      price_data: {
        currency,
        product_data: {
          name: item.selectionText ? `${item.name} (${item.selectionText})` : item.name,
        },
        unit_amount: Math.round(item.unitPrice * 100),
      },
      quantity: item.qty,
    })),
    // Keep metadata to short customer/pickup fields only -- item details are
    // reconstructed from Stripe's own line items in confirm-order.js, since
    // metadata values are capped at 500 characters each and a big order's
    // item list could easily exceed that.
    metadata: {
      orderId: orderId || '',
      cafeName: cafeName || '',
      customerName,
      phone,
      pickupDay: pickupDay || '',
      pickupTime: pickupTime || '',
    },
  };

  try {
    const res = await fetch(STRIPE_SESSIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: toStripeFormParams(stripeBody).toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Stripe session creation failed:', data);
      return jsonResponse(502, { ok: false, error: (data.error && data.error.message) || 'Stripe rejected the request.' });
    }

    return jsonResponse(200, { ok: true, url: data.url, sessionId: data.id });
  } catch (e) {
    console.error('Stripe request failed:', e.message);
    return jsonResponse(502, { ok: false, error: 'Could not reach Stripe.' });
  }
};
