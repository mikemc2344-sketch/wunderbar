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
 *       { "name": "Latte", "qty": 2, "sizeLabel": "Large", "addonLabels": [],
 *         "choiceLabel": null, "multiChoiceLabels": [], "notes": "" }
 *     ]
 *   }
 *   PRICES ARE NOT TRUSTED FROM THE BROWSER. Each item is priced here from:
 *     - menu_items.base_price_cents in Supabase (+ the cafe's markup_percent)
 *     - the SIZE / ADD-ON price list below (ITEM_OPTIONS)
 *   Any unitPrice the browser sends is ignored. Unknown or inactive items,
 *   sizes or add-ons are rejected, so a tampered cart can't get through.
 *
 * ── What it returns ──
 *   { "ok": true, "url": "https://checkout.stripe.com/..." }
 *   Redirect the browser to that URL (window.location.href = url).
 */

const { jsonResponse, corsHeaders, toStripeFormParams, getCafeBySlug, getMenuItems } = require('./_shared/lib');

const STRIPE_SESSIONS_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';

// ── Sizes, add-ons and free choices (prices in cents, charged as-is, no markup) ──
// Must match the options shown on the site (PRODUCTS in index.html).
// If you add an add-on or change its price on the site, change it here too,
// otherwise orders using it will be rejected.
const ITEM_OPTIONS = {
  'Benedict Bagel':          { addons: { 'Extra Cheese': 150, 'Extra Bacon': 200, 'Extra Sauce': 100 } },
  'English Breaky Muffin':   { addons: { 'Extra Cheese': 150, 'Extra Bacon': 200, 'Extra Sauce': 100 } },
  'Breaky Wrap':             { addons: { 'Extra Cheese': 150, 'Extra Bacon': 200, 'Extra Sauce': 100 } },
  'Bacon, Cheese & Egg Wrap':{ addons: { 'Extra Cheese': 150, 'Extra Bacon': 200, 'Extra Sauce': 100 } },
  'Breaky Burger':           { addons: { 'Extra Cheese': 150, 'Extra Bacon': 200, 'Extra Sauce': 100 } },
  'Tradie Breaky Long Roll': { addons: { 'Extra Cheese': 150, 'Extra Bacon': 200, 'Extra Sauce': 100 } },
  'Spicy Chicken Burger':    { addons: { 'Extra Cheese': 150, 'Extra Bacon': 200, 'Extra Sauce': 100 } },
  'Chicken Schnitzel Burger':   { addons: { 'Extra Cheese': 190, 'Extra Bacon': 290, 'Extra Egg': 190, 'Extra Hollandaise': 250 } },
  'Scotch Fillet Steak Burger': { addons: { 'Extra Cheese': 190, 'Extra Bacon': 290, 'Extra Egg': 190 } },
  'CurryWurst & Chips':      { addons: { 'Add Chip Gravy': 230 } },
  'Mocha':                   { sizes: { 'Small': 0, 'Medium': 100, 'Large': 200 } },
  'Latte':                   { sizes: { 'Small': 0, 'Medium': 100, 'Large': 200 } },
  'Milk Shake':              { choices: ['Chocolate', 'Vanilla', 'Strawberry', 'Caramel', 'Banana', 'Spear Mint', 'Coffee', 'Mango'] },
  'Big Breakfast with German Bratwurst': { choices: ['Over medium', 'Over easy', 'Over hard', 'Scrambled', 'Poached', 'Sunny-side up'] },
};

const MAX_QTY_PER_LINE = 50;

function normaliseName(name) {
  return String(name || '').trim().toLowerCase();
}

function findOptions(name) {
  const key = Object.keys(ITEM_OPTIONS).find((k) => normaliseName(k) === normaliseName(name));
  return key ? ITEM_OPTIONS[key] : {};
}

/**
 * Works out the real price of one cart line on the server.
 * Returns { ok: true, line } or { ok: false, error } with a customer-friendly message.
 */
function priceCartLine(item, menuByName, markupMultiplier) {
  const menuItem = menuByName[normaliseName(item.name)];
  if (!menuItem) {
    return { ok: false, error: `"${item.name}" is no longer available. Please refresh the menu and try again.` };
  }

  const qty = Number(item.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
    return { ok: false, error: `Quantity for "${menuItem.name}" must be between 1 and ${MAX_QTY_PER_LINE}.` };
  }

  const opts = findOptions(menuItem.name);
  let unitCents = Math.round(Number(menuItem.base_price_cents) * markupMultiplier);
  const bits = [];

  // Size
  if (opts.sizes) {
    const size = item.sizeLabel || Object.keys(opts.sizes)[0];
    if (!(size in opts.sizes)) {
      return { ok: false, error: `Size "${size}" isn't available for "${menuItem.name}". Please refresh and try again.` };
    }
    unitCents += opts.sizes[size];
    bits.push(size);
  } else if (item.sizeLabel) {
    return { ok: false, error: `"${menuItem.name}" doesn't come in sizes. Please refresh and try again.` };
  }

  // Free single choice (flavour, egg style)
  if (item.choiceLabel) {
    if (!opts.choices || opts.choices.indexOf(item.choiceLabel) === -1) {
      return { ok: false, error: `"${item.choiceLabel}" isn't an option for "${menuItem.name}". Please refresh and try again.` };
    }
    bits.push(item.choiceLabel);
  }

  // Free multi choice (not used on Wunderbar yet)
  const multi = Array.isArray(item.multiChoiceLabels) ? item.multiChoiceLabels : [];
  if (multi.length) {
    if (!opts.multi || multi.some((m) => opts.multi.indexOf(m) === -1)) {
      return { ok: false, error: `Invalid option selected for "${menuItem.name}". Please refresh and try again.` };
    }
    bits.push(multi.join(', '));
  }

  // Priced add-ons
  const addons = Array.isArray(item.addonLabels) ? item.addonLabels : [];
  const seen = {};
  for (const label of addons) {
    if (!opts.addons || !(label in opts.addons) || seen[label]) {
      return { ok: false, error: `Add-on "${label}" isn't available for "${menuItem.name}". Please refresh and try again.` };
    }
    seen[label] = true;
    unitCents += opts.addons[label];
  }
  if (addons.length) bits.push(addons.join(', '));

  // Customer note for the kitchen (e.g. "no onion"). Kept short: Stripe
  // metadata values are capped at 500 characters.
  const notes = String(item.notes || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  return {
    ok: true,
    line: {
      name: menuItem.name,
      selectionText: bits.join(' \u00b7 '),
      unitCents,
      qty,
      notes,
    },
  };
}

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
  if (items.length > 100) {
    return jsonResponse(400, { ok: false, error: 'Too many items in one order.' });
  }
  for (const item of items) {
    if (!item || !item.name) {
      return jsonResponse(400, { ok: false, error: 'Each item needs a name.' });
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

  // ── Price every line on the server from Supabase (never from the browser) ──
  let menuItems;
  try {
    menuItems = await getMenuItems(cafe.id);
  } catch (e) {
    console.error('Menu lookup failed:', e.message);
    return jsonResponse(503, { ok: false, error: 'The menu is temporarily unavailable. Please try again in a minute.' });
  }
  const menuByName = {};
  for (const m of menuItems) menuByName[normaliseName(m.name)] = m;

  const markupMultiplier = 1 + Number(cafe.markup_percent) / 100;
  if (!Number.isFinite(markupMultiplier) || markupMultiplier < 1) {
    console.error(`Cafe "${cafeSlug}" has an invalid markup_percent:`, cafe.markup_percent);
    return jsonResponse(500, { ok: false, error: 'Cafe pricing is misconfigured.' });
  }

  const pricedLines = [];
  for (const item of items) {
    const result = priceCartLine(item, menuByName, markupMultiplier);
    if (!result.ok) return jsonResponse(400, { ok: false, error: result.error });
    pricedLines.push(result.line);
  }

  // Total the customer pays, in cents (includes markup + sizes/add-ons).
  const totalCents = pricedLines.reduce((sum, l) => sum + l.unitCents * l.qty, 0);

  // Work backwards from the total to the true (pre-markup) amount the cafe
  // should receive, using the cafe's markup_percent. The platform absorbs any
  // fractional cent via the application fee.
  const cafeReceivesCents = Math.round(totalCents / markupMultiplier);
  const applicationFeeCents = totalCents - cafeReceivesCents;

  const stripeBody = {
    mode: 'payment',
    managed_payments: { enabled: false },
    success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/`,
    line_items: pricedLines.map((l) => ({
      price_data: {
        currency,
        product_data: {
          name: l.selectionText ? `${l.name} (${l.selectionText})` : l.name,
          // Shown under the item on Stripe's payment page, so the customer can see their note was kept
          description: l.notes ? `Note: ${l.notes}` : undefined,
          // Read back by confirm-order.js so the note reaches the order email
          metadata: l.notes ? { notes: l.notes } : undefined,
        },
        unit_amount: l.unitCents,
      },
      quantity: l.qty,
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