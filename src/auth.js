const { clerkClient, verifyToken } = require('@clerk/express');
require('dotenv').config();

// -------------------------------------------------------
// requireAuth — protects routes that need a logged-in user
// -------------------------------------------------------
const requireAuth = async (req, res, next) => {
  try {
    // DEV ONLY - bypass auth with just a userId header
    if (process.env.NODE_ENV === 'development' && req.headers['x-dev-user-id']) {
      req.auth = { userId: req.headers['x-dev-user-id'] };
      return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    req.auth = {
      userId: payload.sub,
    };

    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// -------------------------------------------------------
// optionalAuth — attaches user if token exists, but
// does NOT block the request if there's no token.
// Used for routes guests can also access (e.g. join room)
// -------------------------------------------------------
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.auth = null;
      return next();
    }

    const token = authHeader.split(' ')[1];

    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    req.auth = {
      userId: payload.sub,
    };

    next();
  } catch (err) {
    // Token exists but is bad — still let them through as guest
    req.auth = null;
    next();
  }
};

// -------------------------------------------------------
// requireHost — use AFTER requireAuth
// Checks that the authenticated user is the room host
// -------------------------------------------------------
const requireHost = async (req, res, next) => {
  try {
    const supabase = require('../services/supabase');
    const { roomId } = req.params;
    const { userId } = req.auth;

    const { data: room, error } = await supabase
      .from('rooms')
      .select('host_id')
      .eq('id', roomId)
      .single();

    if (error || !room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    if (room.host_id !== userId) {
      return res.status(403).json({ error: 'Only the host can do this' });
    }

    // Attach room to request so route handler doesn't need to fetch it again
    req.room = room;
    next();
  } catch (err) {
    console.error('requireHost error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { requireAuth, optionalAuth, requireHost };