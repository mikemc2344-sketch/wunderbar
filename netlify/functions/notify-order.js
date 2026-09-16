/**
 * notify-order.js
 * Netlify Function — POST an order here, it emails (and optionally texts) the café.
 *
 * Deploy path: netlify/functions/notify-order.js
 * Live URL once deployed: https://<your-site>.netlify.app/.netlify/functions/notify-order
 *
 * ── Required environment variables (set in Netlify dashboard → Site settings → Environment variables) ──
 *   RESEND_API_KEY   Your Resend API key (resend.com — free tier: 3,000 emails/month)
 *   NOTIFY_EMAIL     Where order emails should land, e.g. orders@wunderbarlunchbar.com.au
 *                     (comma-separate for more than one recipient)
 *
 * ── Optional environment variables ──
 *   FROM_EMAIL              Sender address. Must be on a domain verified in Resend.
 *                            Defaults to onboarding@resend.dev (fine for testing, gets
 *                            flagged as spam by some inboxes in real use — verify your
 *                            own domain in Resend before relying on this for real orders).
 *   TWILIO_ACCOUNT_SID       )
 *   TWILIO_AUTH_TOKEN        )  Set all three to also send an SMS. Leave any one unset
 *   TWILIO_FROM_NUMBER       )  and SMS is skipped — email-only still works fine.
 *   NOTIFY_SMS_NUMBER        The café's mobile number to text, e.g. +61412345678
 *   ALLOWED_ORIGIN           Restrict which site can call this (e.g. your storefront's
 *                            URL). Defaults to "*" (any site) — fine while testing,
 *                            worth locking down before real launch.
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
 *   Only customerName, phone, and a non-empty items array are required — everything
 *   else is optional and simply left out of the email/SMS if missing.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TWILIO_ENDPOINT = (sid) => `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatOrderText(order) {
  const lines = [];
  lines.push(`New order${order.cafeName ? ' — ' + order.cafeName : ''}`);
  lines.push(`Order: ${order.orderId || '(no id)'}`);
  lines.push(`Customer: ${order.customerName} · ${order.phone}`);
  if (order.pickupDay || order.pickupTime) {
    lines.push(`Pickup: ${[order.pickupDay, order.pickupTime].filter(Boolean).join(', ')}`);
  }
  lines.push('');
  lines.push('Items:');
  for (const item of order.items) {
    const bits = [`${item.qty}x ${item.name}`];
    if (item.selectionText) bits.push(`(${item.selectionText})`);
    let line = '  - ' + bits.join(' ');
    if (typeof item.unitPrice === 'number') line += ` — $${(item.unitPrice * item.qty).toFixed(2)}`;
    lines.push(line);
    if (item.notes) lines.push(`      note: ${item.notes}`);
  }
  if (typeof order.total === 'number') {
    lines.push('');
    lines.push(`Total: $${order.total.toFixed(2)}`);
  }
  return lines.join('\n');
}

function formatOrderHtml(order) {
  const itemRows = order.items.map((item) => {
    const bits = [`${item.qty}&times; ${escapeHtml(item.name)}`];
    if (item.selectionText) bits.push(`<span style="color:#666;">(${escapeHtml(item.selectionText)})</span>`);
    const priceCell = typeof item.unitPrice === 'number'
      ? `$${(item.unitPrice * item.qty).toFixed(2)}`
      : '';
    const noteRow = item.notes
      ? `<tr><td colspan="2" style="padding:0 0 8px 16px;color:#888;font-size:13px;font-style:italic;">"${escapeHtml(item.notes)}"</td></tr>`
      : '';
    return `<tr><td style="padding:4px 0;">${bits.join(' ')}</td><td style="padding:4px 0;text-align:right;">${priceCell}</td></tr>${noteRow}`;
  }).join('');

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;">
    <h2 style="margin-bottom:4px;">New order${order.cafeName ? ' — ' + escapeHtml(order.cafeName) : ''}</h2>
    <p style="color:#666;margin-top:0;">Order ${escapeHtml(order.orderId || '')}</p>
    <p><strong>${escapeHtml(order.customerName)}</strong> &middot; ${escapeHtml(order.phone)}</p>
    ${(order.pickupDay || order.pickupTime) ? `<p>Pickup: ${escapeHtml([order.pickupDay, order.pickupTime].filter(Boolean).join(', '))}</p>` : ''}
    <table style="width:100%;border-collapse:collapse;margin-top:12px;">
      ${itemRows}
      ${typeof order.total === 'number' ? `<tr><td style="padding-top:10px;font-weight:600;border-top:2px solid #222;">Total</td><td style="padding-top:10px;font-weight:600;text-align:right;border-top:2px solid #222;">$${order.total.toFixed(2)}</td></tr>` : ''}
    </table>
  </div>`;
}

function formatOrderSms(order) {
  const itemSummary = order.items.map((i) => `${i.qty}x ${i.name}`).join(', ');
  const total = typeof order.total === 'number' ? ` — $${order.total.toFixed(2)}` : '';
  let msg = `New order: ${itemSummary}${total}. ${order.customerName} ${order.phone}.`;
  if (order.pickupDay || order.pickupTime) {
    msg += ` Pickup: ${[order.pickupDay, order.pickupTime].filter(Boolean).join(', ')}.`;
  }
  // Keep SMS short — trim hard if someone orders half the menu
  return msg.length > 300 ? msg.slice(0, 297) + '...' : msg;
}

async function sendEmail(order) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.NOTIFY_EMAIL;
  if (!apiKey || !toEmail) return { skipped: true, reason: 'RESEND_API_KEY or NOTIFY_EMAIL not set' };

  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromEmail,
      to: toEmail.split(',').map((s) => s.trim()),
      subject: `New order — ${order.customerName}${order.cafeName ? ' · ' + order.cafeName : ''}`,
      text: formatOrderText(order),
      html: formatOrderHtml(order),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
  return { sent: true };
}

async function sendSms(order) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const to = process.env.NOTIFY_SMS_NUMBER;
  if (!sid || !token || !from || !to) return { skipped: true, reason: 'Twilio env vars not fully set' };

  const params = new URLSearchParams({ To: to, From: from, Body: formatOrderSms(order) });
  const res = await fetch(TWILIO_ENDPOINT(sid), {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Twilio API error (${res.status}): ${body}`);
  }
  return { sent: true };
}

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

  const result = { ok: true, email: null, sms: null };

  try {
    result.email = await sendEmail(order);
  } catch (e) {
    console.error('Email send failed:', e.message);
    result.email = { sent: false, error: e.message };
  }

  try {
    result.sms = await sendSms(order);
  } catch (e) {
    console.error('SMS send failed:', e.message);
    result.sms = { sent: false, error: e.message };
  }

  // Only fail the whole request if BOTH channels genuinely failed (not just skipped)
  const emailFailed = result.email && result.email.sent === false;
  const smsFailed = result.sms && result.sms.sent === false;
  const emailSkipped = result.email && result.email.skipped;
  const smsSkipped = result.sms && result.sms.skipped;

  if (emailFailed && (smsFailed || smsSkipped)) {
    return jsonResponse(502, { ok: false, error: 'Could not deliver the order notification.', detail: result });
  }
  if (emailSkipped && smsSkipped) {
    return jsonResponse(500, { ok: false, error: 'No notification channel is configured (set RESEND_API_KEY + NOTIFY_EMAIL, or the Twilio vars).', detail: result });
  }

  return jsonResponse(200, result);
};