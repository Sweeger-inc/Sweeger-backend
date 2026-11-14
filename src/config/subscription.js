/**
 * Subscription & Pricing Configuration
 * ------------------------------------
 * Easily editable configuration for free trial length, pricing, and currency.
 * 
 * To change the trial duration:
 * - Update FREE_TRIAL_DAYS in your .env (e.g. FREE_TRIAL_DAYS=7)
 * - OR change the default value in `freeTrialDays` below.
 */
require('dotenv').config();

const subscriptionConfig = {
  // Free trial duration in days (Default: 7 days for optimal conversion)
  // Developers can change this directly here or in .env via FREE_TRIAL_DAYS
  freeTrialDays: parseInt(process.env.FREE_TRIAL_DAYS, 10) || 7,

  // Standard subscription pricing (in NGN)
  // 3000 NGN = 300,000 Kobo for Paystack
  monthlyPriceNGN: parseInt(process.env.MONTHLY_PRICE_NGN, 10) || 3000,

  // Currency code
  currency: (process.env.SUBSCRIPTION_CURRENCY || 'NGN').toUpperCase(),

  // Duration in days for a standard paid monthly subscription period
  paidSubscriptionDays: 30,

  // Optional: Paystack recurring plan code if using recurring plans created on Paystack dashboard
  // e.g. 'PLN_xxxxxxxxx'
  paystackPlanCode: process.env.PAYSTACK_PLAN_CODE || null,
};

module.exports = subscriptionConfig;
