require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ytDlp = require('yt-dlp-exec');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

app.use(cors());
app.use(express.json());

// Helper function to map YouTube data to our standard Track format
const mapYouTubeTrack = (item) => {
  const videoId = item.id.videoId || item.id;
  const snippet = item.snippet;
  
  const highResArtwork = snippet.thumbnails.high?.url || snippet.thumbnails.medium?.url || snippet.thumbnails.default?.url;
  const decodedTitle = snippet.title
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return {
    id: videoId,
    title: decodedTitle,
    artist: snippet.channelTitle,
    artwork: highResArtwork || 'https://via.placeholder.com/600',
    url: videoId,
  };
};

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', api: 'YouTube Proxy', timestamp: new Date().toISOString() });
});

// NOVO ENDPOINT DE STREAMING PROXY (TÚNEL SEM ANÚNCIOS)
app.get('/api/proxy-stream/:id', async (req, res) => {
  const videoId = req.params.id;
  if (!videoId) return res.status(400).send('Video ID required');

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Obter o melhor formato MP4 que tenha áudio e vídeo juntos (itag 18 ou 22)
    const output = await ytDlp(url, {
      dumpJson: true,
      noWarnings: true,
      format: 'best[ext=mp4][vcodec^=avc1][acodec^=mp4a]/best[ext=mp4]/best'
    });

    const streamUrl = output.url;
    if (!streamUrl) throw new Error('No stream URL found');

    // Configuração do Túnel (Proxy)
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.referer;

    const response = await axios({
      method: 'get',
      url: streamUrl,
      headers: headers,
      responseType: 'stream',
      timeout: 10000
    });

    // Encaminha os headers do YouTube (Content-Type, Content-Length, Content-Range)
    res.set(response.headers);
    res.status(response.status);

    // Pipe (Túnel de dados) do YouTube direto para o App
    response.data.pipe(res);

  } catch (error) {
    console.error('Proxy Error:', error.message);
    res.status(500).send('Erro ao processar stream: ' + error.message);
  }
});

// Cache in memory to prevent quota burns on YouTube API
let exploreCache = null;
let lastExploreFetch = 0;
const CACHE_DURATION = 1000 * 60 * 60; // 1 hora

app.get('/api/explore', async (req, res) => {
  if (exploreCache && (Date.now() - lastExploreFetch) < CACHE_DURATION) {
    return res.json({ shelves: exploreCache });
  }

  const queries = [
    { title: 'Top Brasil', q: 'top hits brasil 2025 videoclipe' },
    { title: 'Funk', q: 'funk 2025 clipes lançamentos' },
    { title: 'Sertanejo', q: 'sertanejo top clipes' },
    { title: 'Trap', q: 'trap brasil videoclipes' }
  ];
  
  try {
    const promises = queries.map(async (category) => {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=${encodeURIComponent(category.q)}&key=${YOUTUBE_API_KEY}`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.error) throw new Error(data.error.message);
      const validTracks = (data.items || []).map(mapYouTubeTrack);
        
      return { title: category.title, tracks: validTracks };
    });

    const shelves = await Promise.all(promises);
    exploreCache = shelves;
    lastExploreFetch = Date.now();
    res.json({ shelves });
  } catch (error) {
    console.error('Explore API error:', error.message);
    res.status(500).json({ error: 'Failed to fetch explore categories' });
  }
});

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Query parameter "q" is required' });

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=25&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) return res.status(500).json({ error: 'YouTube API error', details: data.error.message });
    const tracks = (data.items || []).map(mapYouTubeTrack);
    res.json({ results: tracks });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Failed to search YouTube' });
  }
});

// NOVO ENDPOINT DE LETRAS (LRCLIB)
app.get('/api/lyrics', async (req, res) => {
  const { artist, title, duration } = req.query;
  console.log(`[LYRICS] Procurando: ${artist} - ${title} (${duration}s)`);
  
  if (!artist || !title) return res.status(400).json({ error: 'Artist and Title are required' });

  try {
    // Tenta busca exata primeiro
    let url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    if (duration) url += `&duration=${Math.round(duration)}`;

    const response = await axios.get(url, {
      headers: { 'User-Agent': 'CyberAudio/1.0 (https://github.com/neyva/CyberAudio)' },
      timeout: 5000
    });

    res.json(response.data);
  } catch (error) {
    console.log(`[LYRICS] Exact match failed for ${title}. Attempting generic search...`);
    // Se não achar exato, tenta busca genérica
    try {
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`)}`;
      const searchRes = await axios.get(searchUrl, { timeout: 5000 });
      if (searchRes.data && searchRes.data.length > 0) {
        return res.json(searchRes.data[0]);
      }
      res.status(404).json({ error: 'Lyrics not found' });
    } catch (innerError) {
      console.error(`[LYRICS] Final failure for ${title}:`, innerError.message);
      res.status(500).json({ error: 'Failed to fetch lyrics' });
    }
  }
});

// Middleware 404 (JSON)
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global Error Handler (JSON)
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err.stack);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`\n📺 YouTube Music Backend PRO iniciado em http://localhost:${PORT}`);
  console.log(`   GET /api/proxy-stream/:id → Stream Ad-free Bypass Ativado`);
  console.log(`   GET /api/lyrics → Motor de letras sincronizadas Ativado`);
});


