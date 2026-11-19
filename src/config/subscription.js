/**
 * Subscription & Pricing Configuration
 * ------------------------------------
 * Easily editable configuration for free trial length, pricing, and currency.
 *
 * PRD v7 defaults:
 * - ₦200 per month
 * - First month (30 days) free trial
 * - Configurable grace period on failed renewals
 */
require('dotenv').config();

const subscriptionConfig = {
  // Free trial duration in days (PRD v7 default: 30 days / first month free)
  freeTrialDays: parseInt(process.env.FREE_TRIAL_DAYS, 10) || 30,

  // Standard subscription pricing (in NGN) — PRD v7: ₦200/month
  monthlyPriceNGN: parseInt(process.env.MONTHLY_PRICE_NGN, 10) || 200,

  // Currency code
  currency: (process.env.SUBSCRIPTION_CURRENCY || 'NGN').toUpperCase(),

  // Duration in days for a standard paid monthly subscription period
  paidSubscriptionDays: 30,

  // Grace period in days when a recurring renewal payment fails
  gracePeriodDays: parseInt(process.env.SUBSCRIPTION_GRACE_DAYS, 10) || 3,

  // Optional: Paystack recurring plan code if using recurring plans created on Paystack dashboard
  paystackPlanCode: process.env.PAYSTACK_PLAN_CODE || null,
};

module.exports = subscriptionConfig;
