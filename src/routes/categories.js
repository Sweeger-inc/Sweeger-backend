const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

// Available categories
const AVAILABLE_CATEGORIES = [
  'Sports',
  'Music',
  'Gaming',
  'Movies',
  'Comedy',
  'News',
  'Technology',
  'Fashion',
  'Food',
  'Travel',
  'Education',
  'Lifestyle',
];

// GET /api/categories — get all available categories
router.get('/', async (req, res) => {
  return res.status(200).json({ categories: AVAILABLE_CATEGORIES });
});

// GET /api/categories/mine — get current user's selected categories
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { data, error } = await supabase
      .from('user_categories')
      .select('category, created_at')
      .eq('user_id', userId);

    if (error) throw error;

    return res.status(200).json({
      count: data.length,
      categories: data.map(d => d.category),
    });

  } catch (err) {
    console.error('Get categories error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// POST /api/categories — save user's selected categories (max 2)
router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const { categories } = req.body;

    if (!categories || !Array.isArray(categories)) {
      return res.status(400).json({ error: 'Categories must be an array' });
    }

    if (categories.length !== 2) {
      return res.status(400).json({ error: 'You must select exactly 2 categories' });
    }

    // Validate categories are from the allowed list
    const invalid = categories.filter(c => !AVAILABLE_CATEGORIES.includes(c));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid categories: ${invalid.join(', ')}` });
    }

    // Delete existing categories first
    await supabase
      .from('user_categories')
      .delete()
      .eq('user_id', userId);

    // Insert new ones
    await supabase
      .from('user_categories')
      .insert(categories.map(category => ({ user_id: userId, category })));

    return res.status(200).json({
      message: 'Categories saved successfully',
      categories,
    });

  } catch (err) {
    console.error('Save categories error:', err.message);
    return res.status(500).json({ error: 'Failed to save categories' });
  }
});

// DELETE /api/categories — clear user's categories
router.delete('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth.userId;

    await supabase
      .from('user_categories')
      .delete()
      .eq('user_id', userId);

    return res.status(200).json({ message: 'Categories cleared' });

  } catch (err) {
    console.error('Clear categories error:', err.message);
    return res.status(500).json({ error: 'Failed to clear categories' });
  }
});

module.exports = router;
