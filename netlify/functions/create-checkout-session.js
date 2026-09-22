/**
 * create-checkout-session.js
 * POST the cart here; it creates a Stripe Checkout session and returns the URL
 * to send the customer to for payment. Called by the "Place order" button.
 *
 * ── Required environment variables ──
 *   STRIPE_SECRET_KEY         From your Stripe dashboard (Developers -> API keys).
 *                              Use a "sk_test_..." key while testing, switch to
 *                              "sk_live_..." only once you're ready for real charges.
 *   CAFE_SLUG                 This site's slug in the Supabase `cafes` table (e.g. "wunderbar") --
 *                              markup % and Stripe Connect account ID are looked up from there.
 *   SUPABASE_URL               )
 *   SUPABASE_SERVICE_ROLE_KEY  )  Supabase project credentials
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
 *   unitPrice is still the marked-up, customer-facing price (same as the site displays)
 *   -- the split between cafe and platform is worked out below from the cafe's
 *   markup_percent, so the front-end doesn't need to change.
 *
 * ── What it returns ──
 *   { "ok": true, "url": "https://checkout.stripe.com/..." }
 *   Redirect the browser to that URL (window.location.href = url).
 */

const { jsonResponse, corsHeaders, toStripeFormParams, getCafeBySlug } = require('./_shared/lib');

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

  const cafeSlug = process.env.CAFE_SLUG;
  if (!cafeSlug) {
    return jsonResponse(500, { ok: false, error: 'CAFE_SLUG is not set.' });
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

  let cafe;
  try {
    cafe = await getCafeBySlug(cafeSlug);
  } catch (e) {
    console.error('Cafe lookup failed:', e.message);
    return jsonResponse(500, { ok: false, error: 'Could not look up cafe configuration.' });
  }

  const currency = (process.env.CURRENCY || 'aud').toLowerCase();

  // Netlify passes the original request origin through in headers -- fall back
  // to constructing it from "host" if a browser or proxy doesn't send "origin".
  const origin = event.headers.origin || `https://${event.headers.host}`;

  // Total the customer pays, in cents -- this already includes the cafe's
  // markup_percent, since item.unitPrice is the marked-up display price.
  const totalCents = items.reduce(
    (sum, item) => sum + Math.round(item.unitPrice * 100) * item.qty,
    0
  );

  // Work backwards from the total to the true (pre-markup) amount the cafe
  // should receive, using the same markup_percent stored in Supabase that
  // the site's prices were built from. Rounding is unavoidable here (cents
  // can't split perfectly) -- the platform absorbs any fractional cent via
  // the application fee, which is the safer side for that to land on.
  const markupMultiplier = 1 + Number(cafe.markup_percent) / 100;
  const cafeReceivesCents = Math.round(totalCents / markupMultiplier);
  const applicationFeeCents = totalCents - cafeReceivesCents;

  const stripeBody = {
    mode: 'payment',
    managed_payments: { enabled: false },
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
      cafeName: cafeName || cafe.name || '',
      customerName,
      phone,
      pickupDay: pickupDay || '',
      pickupTime: pickupTime || '',
    },
  };

  // Only split the payment if this cafe has completed Stripe Connect onboarding.
  // A cafe with no stripe_connected_account_id yet still checks out normally --
  // the full amount just lands in the platform account, same as before, until
  // their Connect account is set up.
  if (cafe.stripe_connected_account_id) {
    stripeBody.payment_intent_data = {
      application_fee_amount: applicationFeeCents,
      on_behalf_of: cafe.stripe_connected_account_id,
      transfer_data: {
        destination: cafe.stripe_connected_account_id,
      },
      statement_descriptor_suffix: cafe.slug.toUpperCase(),
    };
  } else {
    console.warn(`Cafe "${cafeSlug}" has no stripe_connected_account_id -- charging full amount to platform account.`);
  }

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