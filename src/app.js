const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

// --- Middleware ---
app.use(helmet());
app.use(cors({
  origin: '*',
  credentials: false,
}));
app.use(morgan('dev'));

// Raw body for webhooks — must come BEFORE express.json()
app.use('/api/webhooks', express.raw({ type: 'application/json' }));

// Parse JSON for all other routes
app.use(express.json());

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Sweeger backend is running',
    timestamp: new Date().toISOString(),
  });
});

// --- Routes ---
app.use('/api/search', require('./routes/search'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/rooms/:roomId/chat', require('./routes/chat'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/follows', require('./routes/follows'));
app.use('/api/poddy', require('./routes/poddy'));
app.use('/api/subscriptions', require('./routes/subscriptions'));

// --- 404 handler ---
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// --- Global error handler ---
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Sweeger backend running on port ${PORT}`);
});
