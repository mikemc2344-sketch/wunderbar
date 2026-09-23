/**
 * confirm-order.js
 * Called by the success page after Stripe redirects the customer back.
 * Verifies the payment actually succeeded (never trust the redirect alone --
 * anyone could type a fake success URL), then sends the same order
 * notification email/SMS as notify-order.js, using the real line items
 * Stripe recorded rather than trusting anything from the browser.
 *
 * GET /.netlify/functions/confirm-order?session_id=cs_test_...
 *
 * Uses the same STRIPE_SECRET_KEY, RESEND_API_KEY, NOTIFY_EMAIL, and
 * (optional) Twilio environment variables as the other two functions.
 */

const { jsonResponse, corsHeaders, notifyBothChannels } = require('./_shared/lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { ok: false, error: 'Use GET' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return jsonResponse(500, { ok: false, error: 'STRIPE_SECRET_KEY is not set.' });
  }

  const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;
  if (!sessionId) {
    return jsonResponse(400, { ok: false, error: 'Missing session_id' });
  }

  const authHeaders = { Authorization: `Bearer ${secretKey}` };

  let session, lineItems;
  try {
    const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { headers: authHeaders });
    session = await sessionRes.json();
    if (!sessionRes.ok) {
      return jsonResponse(404, { ok: false, error: (session.error && session.error.message) || 'Session not found.' });
    }

    const lineItemsRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100&expand%5B%5D=data.price.product`, { headers: authHeaders });
    const lineItemsData = await lineItemsRes.json();
    lineItems = lineItemsData.data || [];
  } catch (e) {
    console.error('Stripe lookup failed:', e.message);
    return jsonResponse(502, { ok: false, error: 'Could not reach Stripe to verify this payment.' });
  }

  // This is the actual security check -- only proceed if Stripe itself says
  // this session was paid. Never trust query params or anything the browser claims.
  if (session.payment_status !== 'paid') {
    return jsonResponse(402, { ok: false, error: 'This order has not been paid.', paymentStatus: session.payment_status });
  }

  const meta = session.metadata || {};
  const items = lineItems.map((li) => {
    // The customer's note is stored on the line's product (see
    // create-checkout-session.js); expand=data.price.product brings it back.
    const product = li.price && typeof li.price.product === 'object' ? li.price.product : null;
    const notes = (product && product.metadata && product.metadata.notes) || '';
    return {
      name: li.description,
      qty: li.quantity,
      unitPrice: li.amount_total / 100 / li.quantity,
      notes,
    };
  });

  const order = {
    orderId: meta.orderId || sessionId.slice(-8).toUpperCase(),
    cafeName: meta.cafeName,
    customerName: meta.customerName,
    phone: meta.phone,
    pickupDay: meta.pickupDay,
    pickupTime: meta.pickupTime,
    total: session.amount_total / 100,
    items,
    paid: true,
  };

  const notifyResult = await notifyBothChannels(order);

  // Notification hiccups don't change the fact that payment succeeded --
  // the customer paid, so we confirm their order either way and just log
  // the notification outcome for you to notice separately if it failed.
  if (notifyResult.email && notifyResult.email.sent === false) {
    console.error('Order paid but notification email failed:', notifyResult.email.error, '-- order:', order.orderId);
  }

  return jsonResponse(200, {
    ok: true,
    order: {
      orderId: order.orderId,
      customerName: order.customerName,
      phone: order.phone,
      pickupDay: order.pickupDay,
      pickupTime: order.pickupTime,
      total: order.total,
      items: order.items,
    },
    notification: notifyResult,
  });
};
