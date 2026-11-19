const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');
const { ONBOARDING_INTERESTS } = require('./categories');
const { isUserPremium } = require('./subscriptions');

const ALLOWED_GENDERS = ['Male', 'Female', 'Prefer not to say'];

// --------------------------------------------------------
// GET /api/profile — get current user's profile, interests, and onboarding state
// --------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const [{ data: user }, { data: cats }, premium] = await Promise.all([
      supabase.from('users').select('*').eq('id', userId).maybeSingle(),
      supabase.from('user_categories').select('category').eq('user_id', userId),
      isUserPremium(userId),
    ]);

    const interests = user?.interests?.length
      ? user.interests
      : (cats || []).map((c) => c.category);

    const onboardingCompleted = Boolean(
      user?.onboarding_completed ||
        (interests.length === 2 && user?.gender && user?.age && user?.location)
    );

    return res.status(200).json({
      profile: {
        id: userId,
        display_name: user?.display_name || null,
        username: user?.username || null,
        email: user?.email || null,
        avatar_url: user?.avatar_url || null,
        interests,
        gender: user?.gender || null,
        age: user?.age || null,
        location: user?.location || null,
        poddy_privacy: user?.poddy_privacy || 'open',
        onboarding_completed: onboardingCompleted,
        is_premium: premium,
      },
      required_interests_count: 2,
      allowed_interests: ONBOARDING_INTERESTS,
      allowed_genders: ALLOWED_GENDERS,
    });
  } catch (err) {
    console.error('Get profile error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// --------------------------------------------------------
// POST /api/profile/onboarding — complete PRD v7 2-step onboarding
// Step 1: exactly 2 interests (Football, Afrobeats, Nollywood, Gaming, Creators, News)
// Step 2: gender (Male, Female, Prefer not to say), age (numbers only), location (text)
// --------------------------------------------------------
router.post('/onboarding', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const {
      interests,
      gender,
      age,
      location,
      display_name,
      username,
      email,
    } = req.body || {};

    if (!Array.isArray(interests)) {
      return res.status(400).json({ error: 'interests must be an array of 2 items' });
    }
    const uniqueInterests = [...new Set(interests.map((i) => String(i).trim()))];
    if (uniqueInterests.length !== 2) {
      return res.status(400).json({ error: 'You must pick exactly 2 interests' });
    }
    const invalidInterests = uniqueInterests.filter((i) => !ONBOARDING_INTERESTS.includes(i));
    if (invalidInterests.length > 0) {
      return res.status(400).json({
        error: `Invalid interests: ${invalidInterests.join(', ')}. Allowed: ${ONBOARDING_INTERESTS.join(', ')}`,
      });
    }

    if (!ALLOWED_GENDERS.includes(gender)) {
      return res.status(400).json({
        error: `gender must be one of: ${ALLOWED_GENDERS.join(', ')}`,
      });
    }

    const numericAge = Number(age);
    if (!Number.isInteger(numericAge) || numericAge < 13 || numericAge > 120) {
      return res.status(400).json({ error: 'age must be a valid integer (13–120)' });
    }

    const cleanLocation = String(location || '').trim();
    if (!cleanLocation) {
      return res.status(400).json({ error: 'location is required' });
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('id, display_name, username, email')
      .eq('id', userId)
      .maybeSingle();

    const profilePayload = {
      id: userId,
      display_name: display_name || existingUser?.display_name || 'Sweeger User',
      username:
        username ||
        existingUser?.username ||
        (display_name || userId).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20),
      email: email || existingUser?.email || null,
      interests: uniqueInterests,
      gender,
      age: numericAge,
      location: cleanLocation,
      onboarding_completed: true,
      updated_at: new Date().toISOString(),
    };

    const { data: savedUser, error: saveErr } = await supabase
      .from('users')
      .upsert(profilePayload, { onConflict: 'id' })
      .select()
      .single();

    if (saveErr) throw saveErr;

    await supabase.from('user_categories').delete().eq('user_id', userId);
    await supabase
      .from('user_categories')
      .insert(uniqueInterests.map((category) => ({ user_id: userId, category })));

    return res.status(200).json({
      message: 'Onboarding completed',
      profile: savedUser,
    });
  } catch (err) {
    console.error('Onboarding save error:', err.message);
    return res.status(500).json({ error: 'Failed to save onboarding profile' });
  }
});

// --------------------------------------------------------
// PATCH /api/profile — update editable profile fields
// --------------------------------------------------------
router.patch('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { display_name, username, gender, age, location } = req.body || {};

    const patch = { updated_at: new Date().toISOString() };
    if (display_name !== undefined) patch.display_name = String(display_name).trim();
    if (username !== undefined) patch.username = String(username).trim().toLowerCase();
    if (location !== undefined) patch.location = String(location).trim();
    if (gender !== undefined) {
      if (!ALLOWED_GENDERS.includes(gender)) {
        return res.status(400).json({ error: 'Invalid gender value' });
      }
      patch.gender = gender;
    }
    if (age !== undefined) {
      const numericAge = Number(age);
      if (!Number.isInteger(numericAge) || numericAge < 13 || numericAge > 120) {
        return res.status(400).json({ error: 'Invalid age value' });
      }
      patch.age = numericAge;
    }

    const { data, error } = await supabase
      .from('users')
      .update(patch)
      .eq('id', userId)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });

    return res.status(200).json({ profile: data });
  } catch (err) {
    console.error('Update profile error:', err.message);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
