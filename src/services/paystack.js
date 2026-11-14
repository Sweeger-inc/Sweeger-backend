const crypto = require('crypto');
const subscriptionConfig = require('../config/subscription');
require('dotenv').config();

const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';

class PaystackError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * Helper to make authenticated requests to Paystack API
 */
async function paystackRequest(endpoint, method = 'GET', body = null) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new PaystackError('Paystack secret key is not configured', 503);
  }

  const url = `${PAYSTACK_BASE_URL}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };

  const options = {
    method,
    headers,
    signal: AbortSignal.timeout(10000),
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const json = await res.json().catch(() => null);

  if (!res.ok || !json?.status) {
    const errorMsg = json?.message || `Paystack request failed with status ${res.status}`;
    console.error(`Paystack API error [${endpoint}]:`, errorMsg);
    throw new PaystackError(errorMsg, res.status >= 400 && res.status < 500 ? 400 : 502);
  }

  return json.data;
}

/**
 * Initialize a Paystack payment session
 */
async function initializePayment({ email, amount, userId, callbackUrl, metadata = {} }) {
  if (!email) {
    throw new PaystackError('Customer email is required to initialize payment', 400);
  }

  const priceInNGN = amount || subscriptionConfig.monthlyPriceNGN;
  // Convert NGN to Kobo (1 NGN = 100 Kobo)
  const amountInKobo = Math.round(priceInNGN * 100);

  const payload = {
    email,
    amount: amountInKobo,
    currency: subscriptionConfig.currency,
    callback_url: callbackUrl || `${process.env.FRONTEND_URL || 'https://sweeger.buzz'}/subscription/callback`,
    metadata: {
      user_id: userId,
      trial_days_applied: subscriptionConfig.freeTrialDays,
      ...metadata,
    },
  };

  if (subscriptionConfig.paystackPlanCode) {
    payload.plan = subscriptionConfig.paystackPlanCode;
  }

  const data = await paystackRequest('/transaction/initialize', 'POST', payload);
  return {
    authorization_url: data.authorization_url,
    access_code: data.access_code,
    reference: data.reference,
  };
}

/**
 * Verify a Paystack transaction by reference
 */
async function verifyTransaction(reference) {
  if (!reference) {
    throw new PaystackError('Transaction reference is required', 400);
  }

  const data = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, 'GET');
  return data;
}

/**
 * Verify Paystack webhook HMAC-SHA512 signature
 */
function verifyWebhookSignature(signature, rawBody) {
  if (!signature || !rawBody || !PAYSTACK_SECRET_KEY) {
    return false;
  }

  try {
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest('hex');

    return hash === signature;
  } catch (err) {
    console.error('Paystack signature verification error:', err.message);
    return false;
  }
}

/**
 * Disable a Paystack recurring subscription
 */
async function disableSubscription(code, token) {
  if (!code || !token) return null;
  try {
    return await paystackRequest('/subscription/disable', 'POST', { code, token });
  } catch (err) {
    console.warn(`Could not disable Paystack subscription ${code}:`, err.message);
    return null;
  }
}

module.exports = {
  initializePayment,
  verifyTransaction,
  verifyWebhookSignature,
  disableSubscription,
  PaystackError,
};
