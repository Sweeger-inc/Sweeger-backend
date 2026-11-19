const express = require('express');
const router = express.Router();
const { Webhook } = require('svix');
const supabase = require('../services/supabase');
const subscriptionConfig = require('../config/subscription');
const walletService = require('../services/wallet');

router.post('/clerk', async (req, res) => {
  console.log('📩 Clerk webhook received');

  // --- 1. Verify the webhook is genuinely from Clerk ---
  const secret = process.env.CLERK_WEBHOOK_SECRET;

  if (!secret) {
    console.error('CLERK_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const svixId = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({ error: 'Missing svix headers' });
  }

  let event;
  try {
    const payload = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body);

    const wh = new Webhook(secret);
    event = wh.verify(payload, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });
    console.log('Event type received:', event.type);
  } catch (err) {
    console.error('Failed to verify Clerk webhook:', err.message);
    return res.status(400).json({ error: 'Invalid webhook signature or body' });
  }

  const { type, data } = event;
  console.log(`Webhook event type: ${type}`);

  try {
    if (type === 'user.created') {
      const userId = data.id;
      const firstName = data.first_name || '';
      const lastName = data.last_name || '';
      const primaryEmail = data.email_addresses?.[0]?.email_address || null;
      const displayName =
        `${firstName} ${lastName}`.trim() ||
        primaryEmail?.split('@')[0] ||
        'User';
      const avatarUrl = data.image_url || null;

      console.log(`Creating user in Supabase: ${userId} — ${displayName}`);

      const { error } = await supabase
        .from('users')
        .insert({
          id: userId,
          display_name: displayName,
          username: data.username || displayName.toLowerCase().replace(/[^a-z0-9_]/g, '') || userId.slice(0, 12),
          email: primaryEmail,
          avatar_url: avatarUrl,
        });

      if (error) {
        console.error('Supabase insert error:', error.message);
        return res.status(500).json({ error: 'Failed to create user' });
      }

      console.log(`✅ User ${userId} saved to Supabase`);
    }

    if (type === 'user.deleted') {
      const userId = data.id;
      console.log(`Deleting user from Supabase: ${userId}`);

      const { error } = await supabase
        .from('users')
        .delete()
        .eq('id', userId);

      if (error) {
        console.error('Supabase delete error:', error.message);
        return res.status(500).json({ error: 'Failed to delete user' });
      }

      console.log(`✅ User ${userId} deleted from Supabase`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// --------------------------------------------------------
// POST /api/webhooks/paystack — handle Paystack payment events
// Handles: subscription.create, charge.success (premium & wallet top-up),
//          subscription.disable, subscription.not_renew, invoice.payment_failed
// --------------------------------------------------------
router.post('/paystack', async (req, res) => {
  console.log('📩 Paystack webhook received');

  const paystack = require('../services/paystack');
  const signature = req.headers['x-paystack-signature'];

  const isVerified = paystack.verifyWebhookSignature(signature, req.body);
  if (!isVerified) {
    console.warn('⚠️ Invalid Paystack webhook signature');
    return res.status(401).json({ error: 'Invalid Paystack webhook signature' });
  }

  let event;
  try {
    const rawString = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body);
    event = JSON.parse(rawString);
  } catch (err) {
    console.error('Failed to parse Paystack webhook payload:', err.message);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const { event: eventType, data } = event;
  console.log(`Paystack event: ${eventType}`);

  try {
    if (eventType === 'charge.success') {
      const userId = data.metadata?.user_id;
      const purpose = data.metadata?.purpose;

      if (userId && purpose === 'wallet_topup') {
        const amountNGN = Math.round(Number(data.amount || 0) / 100);
        await walletService.creditWallet({
          userId,
          amountNGN,
          reference: data.reference,
          description: `Paystack wallet top up (₦${amountNGN})`,
          metadata: { paystack_id: data.id },
        });
        console.log(`✅ Wallet topped up for ${userId}: ₦${amountNGN}`);
      } else if (userId) {
        console.log(`Activating subscription for user: ${userId} via Paystack webhook`);
        const subscriptionStart = new Date(data.paid_at || Date.now());
        const subscriptionEnd = new Date(subscriptionStart);
        subscriptionEnd.setDate(subscriptionEnd.getDate() + subscriptionConfig.paidSubscriptionDays);

        await supabase
          .from('subscriptions')
          .upsert(
            {
              user_id: userId,
              is_premium: true,
              status: 'active',
              subscription_start: subscriptionStart.toISOString(),
              subscription_end: subscriptionEnd.toISOString(),
              grace_period_end: null,
              paystack_customer_id: data.customer?.customer_code || null,
              paystack_subscription_code: data.subscription?.subscription_code || data.reference,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' }
          );

        console.log(`✅ Subscription activated for ${userId}`);
      }
    }

    if (eventType === 'subscription.create') {
      const userId = data.metadata?.user_id;
      const customerCode = data.customer?.customer_code;
      const subCode = data.subscription_code;
      const subscriptionStart = new Date();
      const subscriptionEnd = new Date(subscriptionStart);
      subscriptionEnd.setDate(subscriptionEnd.getDate() + subscriptionConfig.paidSubscriptionDays);

      if (userId) {
        await supabase
          .from('subscriptions')
          .upsert(
            {
              user_id: userId,
              is_premium: true,
              status: 'active',
              subscription_start: subscriptionStart.toISOString(),
              subscription_end: subscriptionEnd.toISOString(),
              grace_period_end: null,
              paystack_customer_id: customerCode || null,
              paystack_subscription_code: subCode || null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' }
          );
      }
    }

    if (eventType === 'invoice.payment_failed') {
      const subCode = data.subscription?.subscription_code;
      const customerCode = data.customer?.customer_code;
      const graceEnd = new Date();
      graceEnd.setDate(graceEnd.getDate() + subscriptionConfig.gracePeriodDays);

      if (subCode || customerCode) {
        let query = supabase
          .from('subscriptions')
          .select('user_id');

        query = subCode
          ? query.eq('paystack_subscription_code', subCode)
          : query.eq('paystack_customer_id', customerCode);

        const { data: subRow } = await query.maybeSingle();

        if (subRow?.user_id) {
          await supabase
            .from('subscriptions')
            .update({
              status: 'past_due',
              is_premium: true,
              grace_period_end: graceEnd.toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', subRow.user_id);

          await supabase.from('notifications').insert({
            user_id: subRow.user_id,
            type: 'subscription_payment_failed',
            title: 'Premium renewal payment failed',
            body: `Your renewal failed. You have a ${subscriptionConfig.gracePeriodDays}-day grace period to update your payment method.`,
            data: { grace_period_end: graceEnd.toISOString() },
            is_read: false,
          });
        }
      }
    }

    if (eventType === 'subscription.disable' || eventType === 'subscription.not_renew') {
      const subCode = data.subscription_code;
      const customerCode = data.customer?.customer_code;

      if (subCode || customerCode) {
        let query = supabase.from('subscriptions').update({
          is_premium: false,
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        });

        if (subCode) {
          query = query.eq('paystack_subscription_code', subCode);
        } else {
          query = query.eq('paystack_customer_id', customerCode);
        }

        await query;
        console.log(`🛑 Subscription disabled for Paystack code: ${subCode || customerCode}`);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Paystack webhook processing error:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;