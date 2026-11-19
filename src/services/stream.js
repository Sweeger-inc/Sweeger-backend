const { StreamClient } = require('@stream-io/node-sdk');
require('dotenv').config();

const hasStreamConfig =
  Boolean(process.env.STREAM_API_KEY) && Boolean(process.env.STREAM_API_SECRET);

let client = null;
if (hasStreamConfig) {
  client = new StreamClient(
    process.env.STREAM_API_KEY,
    process.env.STREAM_API_SECRET,
    { timeout: 3000 }
  );
} else {
  console.warn(
    '[AI Studio] STREAM_API_KEY or STREAM_API_SECRET not configured — using Stream stub'
  );
}

// --------------------------------------------------------
// Generate a Stream token for a user joining a room
// This token gives them access to Stream's voice/video
// --------------------------------------------------------
const generateStreamToken = (userId) => {
  if (!client) {
    return `stub-stream-token-${userId}`;
  }
  try {
    // Stream token never expires during development
    const token = client.generateUserToken({ user_id: userId });
    console.log(`✅ Stream token generated for user: ${userId}`);
    return token;
  } catch (err) {
    console.error('Stream token error:', err.message);
    throw err;
  }
};

// --------------------------------------------------------
// Create a Stream call room when a WatchTogether room
// is created — ties our room ID to a Stream call ID
// --------------------------------------------------------
const createStreamCall = async (roomId, hostId) => {
  if (!client) {
    return { id: roomId, type: 'default', stub: true };
  }
  try {
    const call = client.video.call('default', roomId);

    await call.getOrCreate({
      data: {
        created_by_id: hostId,
        members: [{ user_id: hostId, role: 'host' }],
        settings_override: {
          audio: {
            enabled: true,
            mic_default_on: false,
            default_device: 'speaker',
            noise_cancellation: { mode: 'disabled' }
          },
          video: {
            enabled: true,
            camera_default_on: false,
            target_resolution: {
              width: 1280,
              height: 720,
              framerate: 15,
              bitrate: 1200000,
            }
          },
          // Enable screen sharing
          screensharing: {
            enabled: true,
            access_request_enabled: true,
            target_resolution: {
              width: 1920,
              height: 1080,
              framerate: 15,
              bitrate: 2000000,
            }
          },
        },
      },
    });

    console.log(`✅ Stream call created for room: ${roomId}`);
    return call;
  } catch (err) {
    console.error('Stream call creation error:', err.message);
    throw err;
  }
};

// --------------------------------------------------------
// End a Stream call when the WatchTogether room ends
// --------------------------------------------------------
const endStreamCall = async (roomId) => {
  if (!client) {
    return;
  }
  try {
    const call = client.video.call('default', roomId);
    await call.end();
    console.log(`✅ Stream call ended for room: ${roomId}`);
  } catch (err) {
    // Don't throw — room ending should still work
    // even if Stream call end fails
    console.error('Stream call end error:', err.message);
  }
};

module.exports = { generateStreamToken, createStreamCall, endStreamCall };
