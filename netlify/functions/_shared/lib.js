/**
 * _shared/lib.js
 * Common helpers used by notify-order.js, create-checkout-session.js, and confirm-order.js.
 * Not a Netlify function itself -- just a regular module the functions import from.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TWILIO_ENDPOINT = (sid) => `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
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

// Looks up a café's row (markup %, notification emails, Stripe account, etc.)
// by its slug — each Netlify site sets its own CAFE_SLUG env var so this
// function knows which row belongs to it.
async function getCafeBySlug(slug) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/cafes?slug=eq.${slug}&select=*`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Supabase lookup failed: ${res.status} ${await res.text()}`);
  }

  const rows = await res.json();
  if (rows.length === 0) {
    throw new Error(`No cafe found for slug "${slug}"`);
  }
  return rows[0]; // { id, slug, name, markup_percent, notification_emails, resend_from_address, ... }
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
  if (order.paid) lines.push('\n(Paid online via Stripe)');
  return lines.join('\n');
}

function formatOrderHtml(order) {
  const itemRows = order.items.map((item) => {
    const bits = [`${item.qty}&times; ${escapeHtml(item.name)}`];
    if (item.selectionText) bits.push(`<span style="color:#666;">(${escapeHtml(item.selectionText)})</span>`);
    const priceCell = typeof item.unitPrice === 'number' ? `$${(item.unitPrice * item.qty).toFixed(2)}` : '';
    const noteRow = item.notes
      ? `<tr><td colspan="2" style="padding:0 0 8px 16px;color:#888;font-size:13px;font-style:italic;">"${escapeHtml(item.notes)}"</td></tr>`
      : '';
    return `<tr><td style="padding:4px 0;">${bits.join(' ')}</td><td style="padding:4px 0;text-align:right;">${priceCell}</td></tr>${noteRow}`;
  }).join('');

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;">
    <h2 style="margin-bottom:4px;">New order${order.cafeName ? ' — ' + escapeHtml(order.cafeName) : ''}</h2>
    <p style="color:#666;margin-top:0;">Order ${escapeHtml(order.orderId || '')}${order.paid ? ' &middot; <strong style="color:#146b62;">Paid online</strong>' : ''}</p>
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
  let msg = `New order${order.paid ? ' (PAID)' : ''}: ${itemSummary}${total}. ${order.customerName} ${order.phone}.`;
  if (order.pickupDay || order.pickupTime) {
    msg += ` Pickup: ${[order.pickupDay, order.pickupTime].filter(Boolean).join(', ')}.`;
  }
  return msg.length > 300 ? msg.slice(0, 297) + '...' : msg;
}

// CHANGED: notification emails and sender address now come from the café's
// Supabase row (looked up via CAFE_SLUG) instead of NOTIFY_EMAIL/FROM_EMAIL
// env vars. This is what makes "change it once, updates everywhere" work.
async function sendEmail(order) {
  const apiKey = process.env.RESEND_API_KEY;
  const cafeSlug = process.env.CAFE_SLUG;
  if (!apiKey || !cafeSlug) {
    return { skipped: true, reason: 'RESEND_API_KEY or CAFE_SLUG not set' };
  }

  const cafe = await getCafeBySlug(cafeSlug);

  const toEmails = cafe.notification_emails;
  if (!toEmails || toEmails.length === 0) {
    return { skipped: true, reason: `No notification_emails set in Supabase for cafe "${cafeSlug}"` };
  }

  const fromEmail = cafe.resend_from_address || process.env.FROM_EMAIL || 'onboarding@resend.dev';

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromEmail,
      to: toEmails, // array — Resend sends the same email to every address in it
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

async function notifyBothChannels(order) {
  const result = { email: null, sms: null };
  try { result.email = await sendEmail(order); }
  catch (e) { console.error('Email send failed:', e.message); result.email = { sent: false, error: e.message }; }
  try { result.sms = await sendSms(order); }
  catch (e) { console.error('SMS send failed:', e.message); result.sms = { sent: false, error: e.message }; }
  return result;
}

/**
 * Recursively flattens a plain object/array into Stripe's bracket-notation
 * form-encoded body format, e.g. { line_items: [{ quantity: 2 }] } becomes
 * "line_items[0][quantity]=2". Stripe's API expects this for nested params
 * when using application/x-www-form-urlencoded (no SDK required).
 */
function toStripeFormParams(obj, params, prefix) {
  params = params || new URLSearchParams();
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') {
      toStripeFormParams(value, params, paramKey);
    } else {
      params.append(paramKey, value);
    }
  }
  return params;
}

module.exports = {
  corsHeaders, jsonResponse, escapeHtml,
  formatOrderText, formatOrderHtml, formatOrderSms,
  getCafeBySlug, sendEmail, sendSms, notifyBothChannels,
  toStripeFormParams,
};
