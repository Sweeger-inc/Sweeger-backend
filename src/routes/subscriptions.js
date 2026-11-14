const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const subscriptionConfig = require('../config/subscription');
const paystack = require('../services/paystack');

// Helper — check if trial is still active
const isTrialActive = (trialEnd) => {
  if (!trialEnd) return false;
  return new Date() < new Date(trialEnd);
};

// Helper — check if subscription is still active
const isSubscriptionActive = (subscriptionEnd) => {
  if (!subscriptionEnd) return false;
  return new Date() < new Date(subscriptionEnd);
};

// Helper — calculate remaining days for urgency / customer psychology
const getDaysRemaining = (endDate) => {
  if (!endDate) return 0;
  const msRemaining = new Date(endDate).getTime() - Date.now();
  return Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
};

// --------------------------------------------------------
// GET /api/subscriptions/config
// Returns current pricing & trial configuration for the frontend
// Easily allows the frontend to show "Start your X-day free trial"
// --------------------------------------------------------
router.get('/config', (req, res) => {
  return res.status(200).json({
    free_trial_days: subscriptionConfig.freeTrialDays,
    monthly_price: subscriptionConfig.monthlyPriceNGN,
    currency: subscriptionConfig.currency,
    paystack_plan_code: subscriptionConfig.paystackPlanCode,
  });
});

// --------------------------------------------------------
// POST /api/subscriptions/start-trial
// Called when user signs up — starts the configurable free trial
// --------------------------------------------------------
router.post('/start-trial', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    // Check if subscription record already exists
    const { data: existing, error: checkError } = await supabase
      .from('subscriptions')
      .select('id, status, trial_end')
      .eq('user_id', userId)
      .maybeSingle();

    if (checkError) {
      console.error('Check existing subscription error:', checkError.message);
      return res.status(500).json({ error: 'Failed to check subscription state' });
    }

    if (existing) {
      return res.status(400).json({ 
        error: 'Trial already started',
        status: existing.status,
        trial_end: existing.trial_end,
      });
    }

    const trialStart = new Date();
    const trialEnd = new Date();
    // Use configurable free trial days (default 7 days)
    trialEnd.setDate(trialEnd.getDate() + subscriptionConfig.freeTrialDays);

    const { error: insertError } = await supabase
      .from('subscriptions')
      .insert({
        user_id: userId,
        is_premium: true,
        trial_start: trialStart.toISOString(),
        trial_end: trialEnd.toISOString(),
        status: 'trial',
      });

    if (insertError) {
      console.error('Insert subscription error:', insertError.message);
      return res.status(500).json({ error: 'Failed to start free trial' });
    }

    return res.status(201).json({
      message: `Your ${subscriptionConfig.freeTrialDays}-day free trial has started! Enjoy full premium access.`,
      trial_days: subscriptionConfig.freeTrialDays,
      trial_start: trialStart.toISOString(),
      trial_end: trialEnd.toISOString(),
    });

  } catch (err) {
    console.error('Start trial error:', err.message);
    return res.status(500).json({ error: 'Failed to start trial' });
  }
});

// --------------------------------------------------------
// GET /api/subscriptions/status
// Get current user subscription status with countdown and psychology badges
// --------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data: sub, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      console.error('Fetch subscription status error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch subscription status' });
    }

    if (!sub) {
      return res.status(200).json({
        is_premium: false,
        status: 'none',
        message: `No active subscription. Start your ${subscriptionConfig.freeTrialDays}-day free trial today!`,
        trial_duration_days: subscriptionConfig.freeTrialDays,
      });
    }

    // Check if trial has expired and update status
    if (sub.status === 'trial') {
      if (!isTrialActive(sub.trial_end)) {
        await supabase
          .from('subscriptions')
          .update({
            is_premium: false,
            status: 'expired',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId);

        return res.status(200).json({
          is_premium: false,
          status: 'expired',
          is_trial: true,
          days_remaining: 0,
          message: 'Your free trial has ended. Subscribe now to keep enjoying unlimited rooms and premium features.',
          trial_end: sub.trial_end,
          pricing: {
            amount: subscriptionConfig.monthlyPriceNGN,
            currency: subscriptionConfig.currency,
          },
        });
      }

      // Active trial
      const daysLeft = getDaysRemaining(sub.trial_end);
      return res.status(200).json({
        is_premium: true,
        status: 'trial',
        is_trial: true,
        days_remaining: daysLeft,
        message: daysLeft === 1 
          ? 'Final day of your free trial! Upgrade now so you do not lose access.' 
          : `${daysLeft} days remaining in your free trial.`,
        trial_start: sub.trial_start,
        trial_end: sub.trial_end,
        pricing: {
          amount: subscriptionConfig.monthlyPriceNGN,
          currency: subscriptionConfig.currency,
        },
      });
    }

    // Check if paid subscription has expired
    if (sub.status === 'active') {
      if (!isSubscriptionActive(sub.subscription_end)) {
        await supabase
          .from('subscriptions')
          .update({
            is_premium: false,
            status: 'expired',
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId);

        return res.status(200).json({
          is_premium: false,
          status: 'expired',
          is_trial: false,
          days_remaining: 0,
          message: 'Your subscription has expired. Renew your plan to continue with premium features.',
          pricing: {
            amount: subscriptionConfig.monthlyPriceNGN,
            currency: subscriptionConfig.currency,
          },
        });
      }

      const daysLeft = getDaysRemaining(sub.subscription_end);
      return res.status(200).json({
        is_premium: true,
        status: 'active',
        is_trial: false,
        days_remaining: daysLeft,
        subscription_start: sub.subscription_start,
        subscription_end: sub.subscription_end,
      });
    }

    // Any other status (cancelled, paused, etc.)
    return res.status(200).json({
      is_premium: sub.is_premium,
      status: sub.status,
      is_trial: false,
      trial_start: sub.trial_start,
      trial_end: sub.trial_end,
      subscription_start: sub.subscription_start,
      subscription_end: sub.subscription_end,
    });

  } catch (err) {
    console.error('Subscription status error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// --------------------------------------------------------
// POST /api/subscriptions/initialize
// Initialize Paystack checkout for a user upgrade
// --------------------------------------------------------
router.post('/initialize', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    let { email, callback_url, amount } = req.body || {};

    if (!email) {
      // Look up user display name / fallback
      const { data: userRecord } = await supabase
        .from('users')
        .select('id, display_name')
        .eq('id', userId)
        .maybeSingle();

      email = `${userId}@sweeger.buzz`;
    }

    const checkoutData = await paystack.initializePayment({
      email,
      amount: amount || subscriptionConfig.monthlyPriceNGN,
      userId,
      callbackUrl: callback_url,
    });

    return res.status(200).json({
      message: 'Payment session initialized',
      ...checkoutData,
      amount: amount || subscriptionConfig.monthlyPriceNGN,
      currency: subscriptionConfig.currency,
    });

  } catch (err) {
    console.error('Initialize payment error:', err.message);
    return res.status(err instanceof paystack.PaystackError ? err.status : 500)
      .json({ error: err.message || 'Failed to initialize payment' });
  }
});

// --------------------------------------------------------
// POST /api/subscriptions/verify
// Verify Paystack payment reference and activate premium subscription
// --------------------------------------------------------
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { reference } = req.body || {};

    if (!reference) {
      return res.status(400).json({ error: 'Payment reference is required' });
    }

    // Verify transaction with Paystack
    const transaction = await paystack.verifyTransaction(reference);

    if (transaction.status !== 'success') {
      return res.status(400).json({ 
        error: `Payment verification failed. Paystack status: ${transaction.status}` 
      });
    }

    const subscriptionStart = new Date(transaction.paid_at || Date.now());
    const subscriptionEnd = new Date(subscriptionStart);
    subscriptionEnd.setDate(subscriptionEnd.getDate() + subscriptionConfig.paidSubscriptionDays);

    const { error: upsertError } = await supabase
      .from('subscriptions')
      .upsert({
        user_id: userId,
        is_premium: true,
        status: 'active',
        subscription_start: subscriptionStart.toISOString(),
        subscription_end: subscriptionEnd.toISOString(),
        paystack_customer_id: transaction.customer?.customer_code || null,
        paystack_subscription_code: transaction.subscription?.subscription_code || reference,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('Supabase activate subscription error:', upsertError.message);
      return res.status(500).json({ error: 'Failed to update subscription in database' });
    }

    return res.status(200).json({
      message: 'Payment verified and subscription activated successfully! Welcome to Sweeger Premium.',
      is_premium: true,
      status: 'active',
      subscription_start: subscriptionStart.toISOString(),
      subscription_end: subscriptionEnd.toISOString(),
      reference,
    });

  } catch (err) {
    console.error('Verify payment error:', err.message);
    return res.status(err instanceof paystack.PaystackError ? err.status : 500)
      .json({ error: err.message || 'Failed to verify payment' });
  }
});

// --------------------------------------------------------
// GET /api/subscriptions/verify/:reference
// Convenient GET endpoint for frontend redirection verification
// --------------------------------------------------------
router.get('/verify/:reference', requireAuth, async (req, res) => {
  req.body = { reference: req.params.reference };
  // Forward to verification logic
  return router.handle({ ...req, method: 'POST', url: '/verify' }, res);
});

// --------------------------------------------------------
// POST /api/subscriptions/activate — called after Paystack payment
// Supports both direct reference verification and legacy payloads
// --------------------------------------------------------
router.post('/activate', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { reference, paystack_customer_id, paystack_subscription_code } = req.body || {};

    // If reference provided, verify with Paystack first
    if (reference) {
      const transaction = await paystack.verifyTransaction(reference);
      if (transaction.status !== 'success') {
        return res.status(400).json({ error: 'Payment not successful on Paystack' });
      }
    }

    const subscriptionStart = new Date();
    const subscriptionEnd = new Date();
    subscriptionEnd.setDate(subscriptionEnd.getDate() + subscriptionConfig.paidSubscriptionDays);

    const { error: upsertError } = await supabase
      .from('subscriptions')
      .upsert({
        user_id: userId,
        is_premium: true,
        status: 'active',
        subscription_start: subscriptionStart.toISOString(),
        subscription_end: subscriptionEnd.toISOString(),
        paystack_customer_id: paystack_customer_id || null,
        paystack_subscription_code: paystack_subscription_code || reference || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    if (upsertError) {
      console.error('Activate subscription error:', upsertError.message);
      return res.status(500).json({ error: 'Failed to activate subscription' });
    }

    return res.status(200).json({
      message: 'Subscription activated successfully',
      is_premium: true,
      status: 'active',
      subscription_end: subscriptionEnd.toISOString(),
    });

  } catch (err) {
    console.error('Activate subscription error:', err.message);
    return res.status(500).json({ error: 'Failed to activate subscription' });
  }
});

// --------------------------------------------------------
// POST /api/subscriptions/cancel — cancel subscription
// --------------------------------------------------------
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('paystack_subscription_code')
      .eq('user_id', userId)
      .maybeSingle();

    // If subscription code exists, disable recurring on Paystack
    if (sub?.paystack_subscription_code) {
      await paystack.disableSubscription(sub.paystack_subscription_code).catch(() => null);
    }

    const { error } = await supabase
      .from('subscriptions')
      .update({
        status: 'cancelled',
        is_premium: false,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    if (error) {
      console.error('Cancel subscription error:', error.message);
      return res.status(500).json({ error: 'Failed to cancel subscription' });
    }

    return res.status(200).json({ message: 'Subscription cancelled successfully' });

  } catch (err) {
    console.error('Cancel subscription error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
