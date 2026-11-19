const { google } = require('googleapis');
const supabase = require('./supabase');
require('dotenv').config();

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

// Cache duration — 10 minutes in milliseconds
const CACHE_DURATION = 10 * 60 * 1000;

const extractYouTubeId = (input) => {
  if (!input) return '';
  const trimmed = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    let id = '';
    if (u.hostname.includes('youtu.be')) {
      id = u.pathname.slice(1).split('/')[0];
    } else if (u.hostname.includes('youtube.com')) {
      if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
      else if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/')) {
        id = u.pathname.split('/')[2] || '';
      }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  } catch {
    return '';
  }
};

const getVideoMetadata = async (urlOrId) => {
  const videoId = extractYouTubeId(urlOrId);
  if (!videoId) return null;

  const thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  if (process.env.YOUTUBE_API_KEY) {
    try {
      const resp = await youtube.videos.list({
        part: 'snippet,contentDetails',
        id: videoId,
      });
      const item = resp.data?.items?.[0];
      if (item) {
        return {
          video_id: videoId,
          title: item.snippet?.title || 'YouTube video',
          channel_name: item.snippet?.channelTitle || '',
          thumbnail:
            item.snippet?.thumbnails?.high?.url ||
            item.snippet?.thumbnails?.medium?.url ||
            thumbnail,
          published_at: item.snippet?.publishedAt || null,
        };
      }
    } catch (err) {
      console.warn('YouTube Data API lookup failed, falling back to oEmbed:', err.message);
    }
  }

  // Fallback to YouTube oEmbed (matches sweeger-priority-match-v2 prototype)
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      return {
        video_id: videoId,
        title: data.title || 'YouTube video',
        channel_name: data.author_name || '',
        thumbnail: data.thumbnail_url || thumbnail,
        published_at: null,
      };
    }
  } catch (err) {
    console.warn('YouTube oEmbed fallback failed:', err.message);
  }

  return {
    video_id: videoId,
    title: 'YouTube video',
    channel_name: '',
    thumbnail,
    published_at: null,
  };
};

const searchVideos = async (query) => {
  // --- 1. Check cache first ---
  const { data: cached } = await supabase
    .from('youtube_search_cache')
    .select('*')
    .eq('query', query)
    .single();

  if (cached) {
    const cachedAt = new Date(cached.cached_at).getTime();
    const now = Date.now();
    const isStale = now - cachedAt > CACHE_DURATION;

    if (!isStale) {
      console.log(`Cache hit for query: "${query}"`);
      return cached.results;
    }

    console.log(`Cache stale for query: "${query}" — refetching`);
  }

  // --- 2. Call YouTube API ---
  console.log(`Calling YouTube API for query: "${query}"`);

  const response = await youtube.search.list({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: 12,
    regionCode: 'NG',
    relevanceLanguage: 'en',
    videoEmbeddable: 'true',
  });

  // --- 3. Shape the results ---
  const results = (response.data.items || []).map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    thumbnail:
      item.snippet.thumbnails?.high?.url ||
      item.snippet.thumbnails?.medium?.url ||
      item.snippet.thumbnails?.default?.url ||
      '',
    channelTitle: item.snippet.channelTitle,
    isLive: item.snippet.liveBroadcastContent === 'live',
  }));

  // --- 4. Save to cache ---
  await supabase
    .from('youtube_search_cache')
    .upsert({
      query,
      results,
      cached_at: new Date().toISOString(),
    }, {
      onConflict: 'query'
    });

  console.log(`YouTube API returned ${results.length} results for "${query}"`);
  return results;
};

const getLiveVideos = async () => {
  const response = await youtube.search.list({
    part: 'snippet',
    type: 'video',
    eventType: 'live',
    maxResults: 20,
    regionCode: 'NG',
    relevanceLanguage: 'en',
    videoEmbeddable: 'true',
    order: 'viewCount',
  });

  const videoIds = (response.data.items || [])
    .map(item => item.id?.videoId)
    .filter(Boolean)
    .join(',');

  if (!videoIds) {
    return [];
  }

  // Fetch video statistics separately to get viewer count
  const statsResponse = await youtube.videos.list({
    part: 'statistics,snippet',
    id: videoIds,
  });

  const results = (statsResponse.data.items || []).map(item => ({
    video_id: item.id,
    title: item.snippet.title,
    thumbnail:
      item.snippet.thumbnails?.high?.url ||
      item.snippet.thumbnails?.medium?.url ||
      item.snippet.thumbnails?.default?.url ||
      '',
    channel_name: item.snippet.channelTitle,
    viewer_count: item.statistics?.viewCount || '0',
  }));

  return results;
};

module.exports = { searchVideos, getLiveVideos, extractYouTubeId, getVideoMetadata };