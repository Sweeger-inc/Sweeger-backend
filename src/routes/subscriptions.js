const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// Helper — check if trial is still active
const isTrialActive = (trialEnd) => {
  return new Date() < new Date(trialEnd);
};

// Helper — check if subscription is still active
const isSubscriptionActive = (subscriptionEnd) => {
  if (!subscriptionEnd) return false;
  return new Date() < new Date(subscriptionEnd);
};

// POST /api/subscriptions/start-trial — called when user signs up
router.post('/start-trial', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    // Check if subscription record already exists
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Trial already started' });
    }

    const trialStart = new Date();
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 30);

    await supabase
      .from('subscriptions')
      .insert({
        user_id: userId,
        is_premium: true,
        trial_start: trialStart.toISOString(),
        trial_end: trialEnd.toISOString(),
        status: 'trial',
      });

    return res.status(201).json({
      message: 'Trial started successfully',
      trial_end: trialEnd.toISOString(),
    });

  } catch (err) {
    console.error('Start trial error:', err.message);
    return res.status(500).json({ error: 'Failed to start trial' });
  }
});

// GET /api/subscriptions/status — get current user subscription status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!sub) {
      return res.status(200).json({
        is_premium: false,
        status: 'none',
        message: 'No subscription found',
      });
    }

    // Check if trial has expired and update if needed
    if (sub.status === 'trial' && !isTrialActive(sub.trial_end)) {
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
        message: 'Your free trial has ended. Subscribe to continue with premium features.',
        trial_end: sub.trial_end,
      });
    }

    // Check if paid subscription has expired
    if (sub.status === 'active' && !isSubscriptionActive(sub.subscription_end)) {
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
        message: 'Your subscription has expired. Subscribe to continue with premium features.',
      });
    }

    return res.status(200).json({
      is_premium: sub.is_premium,
      status: sub.status,
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

// POST /api/subscriptions/activate — called after successful Paystack payment
router.post('/activate', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { paystack_customer_id, paystack_subscription_code } = req.body;

    const subscriptionStart = new Date();
    const subscriptionEnd = new Date();
    subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 1);

    await supabase
      .from('subscriptions')
      .upsert({
        user_id: userId,
        is_premium: true,
        status: 'active',
        subscription_start: subscriptionStart.toISOString(),
        subscription_end: subscriptionEnd.toISOString(),
        paystack_customer_id: paystack_customer_id || null,
        paystack_subscription_code: paystack_subscription_code || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

    return res.status(200).json({
      message: 'Subscription activated successfully',
      subscription_end: subscriptionEnd.toISOString(),
    });

  } catch (err) {
    console.error('Activate subscription error:', err.message);
    return res.status(500).json({ error: 'Failed to activate subscription' });
  }
});

// POST /api/subscriptions/cancel — cancel subscription
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    await supabase
      .from('subscriptions')
      .update({
        status: 'cancelled',
        is_premium: false,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    return res.status(200).json({ message: 'Subscription cancelled successfully' });

  } catch (err) {
    console.error('Cancel subscription error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

module.exports = router;
