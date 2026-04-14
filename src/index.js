require('dotenv').config();
const express = require('express');
const cors = require('cors');
const play = require('play-dl');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// LOG DE INICIALIZAÇÃO PARA DEBUG NA RENDER
console.log('\n--- SISTEMA CYBERAUDIO v2.0.1-FIX INICIANDO ---');
console.log(`[CONFIG] Porta: ${PORT}`);
console.log(`[CONFIG] YouTube API Key: ${YOUTUBE_API_KEY ? 'CONFIGURADA (OK)' : 'FALTANDO (ERRO)'}`);

// Configuração de User Agent Global para enganar o bloqueio de 'Confirm you are not a bot'
const CUSTOM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    engine: 'play-dl',
    version: '2.0.0-PRO', // Marcador para sabermos que o código novo entrou
    youtube_key: !!YOUTUBE_API_KEY,
    timestamp: new Date().toISOString() 
  });
});

// ENDPOINT DE STREAMING (DEBUG MÁXIMO)
app.get('/api/proxy-stream/:id', async (req, res) => {
  const videoId = req.params.id;
  console.log(`\n[STREAM REQUEST] Solicitado: ${videoId}`);
  
  if (!videoId) return res.status(400).send('Video ID required');

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Forçar atualização do play-dl
    if (play.is_expired()) {
      console.log('[STREAM] Token expirado, atualizando...');
      await play.refreshToken();
    }

    console.log('[STREAM] Iniciando extração do YouTube com User-Agent Real...');
    const stream = await play.stream(url, {
      quality: 1, 
      seek: 0,
      discordPlayerCompatibility: true,
      userAgent: CUSTOM_USER_AGENT // <--- Enganando o robô do YouTube
    });

    if (!stream || !stream.stream) {
      throw new Error('Falha play-dl: Objeto de fluxo não gerado');
    }

    console.log(`[STREAM] Sucesso play-dl: ${stream.type}. Iniciando Pipe.`);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    stream.stream.pipe(res);

    stream.stream.on('error', (err) => {
      console.error('[PIPE ERROR]', err.message);
      if (!res.headersSent) res.status(500).send('Erro no fluxo: ' + err.message);
    });

    res.on('finish', () => console.log(`[STREAM DONE] Transmitido: ${videoId}`));

  } catch (error) {
    console.error('[STREAM FATAL ERROR]', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Streaming Failed', 
        message: error.message,
        details: error.stack
      });
    }
  }
});

app.get('/api/explore', async (req, res) => {
  console.log('[EXPLORE] Carregando categorias...');
  const queries = [
    { title: 'Top Brasil', q: 'top hits brasil 2025 videoclipe' },
    { title: 'Funk', q: 'funk 2025 clipes lançamentos' },
    { title: 'Sertanejo', q: 'sertanejo top clipes' }
  ];
  
  try {
    const promises = queries.map(async (category) => {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=${encodeURIComponent(category.q)}&key=${YOUTUBE_API_KEY}`;
      const response = await axios.get(url);
      return { 
        title: category.title, 
        tracks: (response.data.items || []).map(item => ({
          id: item.id.videoId,
          title: item.snippet.title,
          artist: item.snippet.channelTitle,
          artwork: item.snippet.thumbnails.high.url
        }))
      };
    });

    const shelves = await Promise.all(promises);
    res.json({ shelves });
  } catch (error) {
    console.error('[EXPLORE ERROR]', error.message);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  console.log(`[SEARCH] Buscando: ${query}`);
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=25&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const response = await axios.get(url);
    const results = (response.data.items || []).map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      artist: item.snippet.channelTitle,
      artwork: item.snippet.thumbnails.high.url
    }));
    res.json({ results });
  } catch (error) {
    console.error('[SEARCH ERROR]', error.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/lyrics', async (req, res) => {
  const { artist, title } = req.query;
  console.log(`[LYRICS] Procurando: ${artist} - ${title}`);
  try {
    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    const response = await axios.get(url, { timeout: 5000 });
    res.json(response.data);
  } catch (error) {
    console.log(`[LYRICS ERROR] ${title}: ${error.message}`);
    res.status(404).json({ error: 'Not found' });
  }
});

app.listen(PORT, () => {
  console.log(`\n📺 Backend PRO rodando na porta ${PORT}`);
});


