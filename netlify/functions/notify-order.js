/**
 * notify-order.js
 * Netlify Function — POST an order here, it emails (and optionally texts) the café.
 *
 * Deploy path: netlify/functions/notify-order.js
 * Live URL once deployed: https://<your-site>.netlify.app/.netlify/functions/notify-order
 *
 * ── Required environment variables ──
 *   RESEND_API_KEY            Your Resend API key
 *   CAFE_SLUG                 This site's slug in the Supabase `cafes` table (e.g. "wunderbar") —
 *                              notification email(s) and sender address are looked up from there.
 *   SUPABASE_URL               )
 *   SUPABASE_SERVICE_ROLE_KEY  )  Supabase project credentials
 *
 * ── Optional environment variables ──
 *   FROM_EMAIL               Fallback sender if the café's row has no resend_from_address set.
 *   TWILIO_ACCOUNT_SID       )
 *   TWILIO_AUTH_TOKEN        )  Set all three to also send an SMS. Leave any one unset
 *   TWILIO_FROM_NUMBER       )  and SMS is skipped — email-only still works fine.
 *   NOTIFY_SMS_NUMBER        The café's mobile number to text, e.g. +61412345678
 *   ALLOWED_ORIGIN           Restrict which site can call this. Defaults to "*".
 *
 * ── What the front-end sends (JSON body) ──
 *   {
 *     "orderId": "O123ABC",
 *     "cafeName": "Wunderbar Lunchbar",
 *     "customerName": "Sam",
 *     "phone": "0412 345 678",
 *     "pickupDay": "Today",
 *     "pickupTime": "12:30pm",
 *     "total": 24.90,
 *     "items": [
 *       { "name": "Breaky Wrap", "qty": 2, "unitPrice": 13.89, "selectionText": "Large", "notes": "no onion" }
 *     ]
 *   }
 *   Only customerName, phone, and a non-empty items array are required.
 */

const { jsonResponse, corsHeaders, notifyBothChannels } = require('./_shared/lib');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Use POST' });
  }

  let order;
  try {
    order = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { ok: false, error: 'Body must be valid JSON' });
  }

  if (!order.customerName || !order.phone || !Array.isArray(order.items) || order.items.length === 0) {
    return jsonResponse(400, { ok: false, error: 'customerName, phone, and a non-empty items array are required' });
  }

  const { email, sms } = await notifyBothChannels(order);
  const result = { ok: true, email, sms };

  const emailFailed = email && email.sent === false;
  const smsFailed = sms && sms.sent === false;
  const emailSkipped = email && email.skipped;
  const smsSkipped = sms && sms.skipped;

  if (emailFailed && (smsFailed || smsSkipped)) {
    return jsonResponse(502, { ok: false, error: 'Could not deliver the order notification.', detail: result });
  }
  if (emailSkipped && smsSkipped) {
    return jsonResponse(500, { ok: false, error: 'No notification channel is configured (check CAFE_SLUG + RESEND_API_KEY + Supabase env vars, or the Twilio vars).', detail: result });
  }

  return jsonResponse(200, result);
};
