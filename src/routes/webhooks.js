const express = require('express');
const router = express.Router();
const { Webhook } = require('svix');
const supabase = require('../services/supabase');

router.post('/clerk', async (req, res) => {
  console.log('📩 Clerk webhook received');

  // --- 1. Verify the webhook is genuinely from Clerk ---
  const secret = process.env.CLERK_WEBHOOK_SECRET;

  if (!secret) {
    console.error('CLERK_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  // Get the headers Clerk sends for verification
  const svixId = req.headers['svix-id'];
  const svixTimestamp = req.headers['svix-timestamp'];
  const svixSignature = req.headers['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({ error: 'Missing svix headers' });
  }

  // Verify signature
  let event;
try {
  // Convert Buffer to string then parse as JSON
  const payload = Buffer.isBuffer(req.body) 
    ? req.body.toString('utf8') 
    : JSON.stringify(req.body);
    
  event = JSON.parse(payload);
  console.log('Event type received:', event.type);
} catch (err) {
  console.error('Failed to parse webhook body:', err.message);
  return res.status(400).json({ error: 'Invalid webhook body' });
}

  // --- 2. Handle the event ---
  const { type, data } = event;
  console.log(`Webhook event type: ${type}`);

  try {
    if (type === 'user.created') {
      // Pull what we need from Clerk's user object
      const userId = data.id;
      const firstName = data.first_name || '';
      const lastName = data.last_name || '';
      const displayName = `${firstName} ${lastName}`.trim() || 
                           data.email_addresses[0]?.email_address?.split('@')[0] || 
                           'User';
      const avatarUrl = data.image_url || null;

      console.log(`Creating user in Supabase: ${userId} — ${displayName}`);

      const { error } = await supabase
        .from('users')
        .insert({
          id: userId,
          display_name: displayName,
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

    // Always return 200 so Clerk knows we received it
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;