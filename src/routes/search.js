const express = require('express');
const router = express.Router();
const { searchVideos, getLiveVideos } = require('../services/youtube');

// GET /api/search?q=burna boy
router.get('/', async (req, res) => {
  try {
    const { q } = req.query;

    // --- Validate query ---
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    if (q.trim().length < 2) {
      return res.status(400).json({ error: 'Query too short' });
    }

    const results = await searchVideos(q.trim().toLowerCase());

    return res.status(200).json({
      query: q,
      count: results.length,
      results,
    });

  } catch (err) {
    console.error('Search error:', err.message);

    // Handle YouTube quota exceeded
    if (err.code === 403) {
      return res.status(503).json({
        error: 'Search is temporarily unavailable. Try again in a few minutes.',
      });
    }

    return res.status(500).json({ error: 'Search failed' });
  }
});

// GET /api/search/live
router.get('/live', async (req, res) => {
  try {
    const results = await getLiveVideos();
    return res.status(200).json({
      count: results.length,
      results,
    });
  } catch (err) {
    console.error('Live videos error:', err.message);
    if (err.code === 403) {
      return res.status(503).json({
        error: 'Live videos temporarily unavailable. Try again later.',
      });
    }
    return res.status(500).json({ error: 'Failed to fetch live videos' });
  }
});

module.exports = router;