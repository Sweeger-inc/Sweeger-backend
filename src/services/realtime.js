const EventEmitter = require('events');

/**
 * Lightweight in-process real-time pub/sub bus for SSE streams.
 * Delivers <1s presence (mic/cam), chat, reactions, lobby arrivals, and crown transfers.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

const channelName = (scope, id) => `${scope}:${id}`;

const publish = (scope, id, event, payload) => {
  if (!scope || !id) return;
  bus.emit(channelName(scope, id), {
    event,
    payload,
    timestamp: new Date().toISOString(),
  });
};

const attachSseStream = (req, res, scope, id, initialSnapshot = null) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('connected', { scope, id, snapshot: initialSnapshot, timestamp: new Date().toISOString() });

  const channel = channelName(scope, id);
  const handler = (msg) => {
    send(msg.event, { ...msg.payload, timestamp: msg.timestamp });
  };
  bus.on(channel, handler);

  const heartbeat = setInterval(() => {
    res.write(`: keepalive ${Date.now()}\n\n`);
  }, 20000);
  if (heartbeat.unref) heartbeat.unref();

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off(channel, handler);
  });
};

module.exports = {
  publish,
  attachSseStream,
};
