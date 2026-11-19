require('dotenv').config();
const supabase = require('./supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Sweeger <notifications@sweeger.buzz>';

// Per-user hourly email throttle to prevent spam (PRD v7 section 13.8)
const recentEmailLog = new Map(); // userId -> timestamps[]
const MAX_EMAILS_PER_HOUR = Number(process.env.MAX_EMAILS_PER_USER_PER_HOUR) || 10;

async function isUnsubscribed(userId) {
  if (!userId) return false;
  const { data } = await supabase
    .from('users')
    .select('email_unsubscribed')
    .eq('id', userId)
    .maybeSingle();
  return Boolean(data?.email_unsubscribed);
}

function isRateLimited(userId) {
  if (!userId) return false;
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const stamps = (recentEmailLog.get(userId) || []).filter((t) => t > windowStart);
  recentEmailLog.set(userId, stamps);
  return stamps.length >= MAX_EMAILS_PER_HOUR;
}

function recordSend(userId) {
  if (!userId) return;
  const stamps = recentEmailLog.get(userId) || [];
  stamps.push(Date.now());
  recentEmailLog.set(userId, stamps);
}

/**
 * Send a transactional email via Resend if configured, or record safely in logs.
 */
async function sendEmail({ userId, to, subject, text, html }) {
  if (userId) {
    if (await isUnsubscribed(userId)) {
      return { sent: false, skipped: 'unsubscribed' };
    }
    if (isRateLimited(userId)) {
      return { sent: false, skipped: 'rate_limited' };
    }
  }

  let recipient = to;
  if (!recipient && userId) {
    const { data: user } = await supabase
      .from('users')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    recipient = user?.email || null;
  }

  if (!recipient) {
    return { sent: false, skipped: 'no_recipient' };
  }

  if (RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: [recipient],
          subject,
          text,
          html: html || `<p>${text}</p>`,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.warn(`Email send warning (${res.status}): ${errBody}`);
        return { sent: false, error: `Upstream ${res.status}` };
      }

      recordSend(userId);
      return { sent: true, provider: 'resend' };
    } catch (err) {
      console.warn('Email dispatch error:', err.message);
      return { sent: false, error: err.message };
    }
  }

  // Graceful fallback when email provider key is not configured
  recordSend(userId);
  console.log(`✉️ [Email queued] To: ${recipient} | Subject: ${subject}`);
  return { sent: false, queued: true, provider: 'log' };
}

module.exports = { sendEmail };
