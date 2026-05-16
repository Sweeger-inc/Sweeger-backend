const { google } = require('googleapis');
const supabase = require('./supabase');
require('dotenv').config();

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

// Cache duration — 10 minutes in milliseconds
const CACHE_DURATION = 10 * 60 * 1000;

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
  const results = response.data.items.map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails.high.url,
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

module.exports = { searchVideos };