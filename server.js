// server.js
// ---------------------------------------------------------------------------
// Servidor Express + Puppeteer para o Movie Card.
//
// O que este arquivo faz:
//   1. Serve o editor visual (public/index.html) normalmente.
//   2. Faz proxy das imagens do TMDB em /tmdb-image/:size/*
//   3. Expõe POST /download-image para gerar o PNG em alta resolução.
// ---------------------------------------------------------------------------

const path = require('path');
const dns = require('node:dns');
const express = require('express');
const puppeteer = require('puppeteer');

// Em algumas redes o IPv6 está mal configurado.
// Força o Node a tentar IPv4 primeiro.
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = process.env.PORT || 3000;

// TMDB
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const ALLOWED_TMDB_SIZES = new Set([
  'w185',
  'w342',
  'w500',
  'w780',
  'original'
]);

// ---------------------------------------------------------------------------
// Chave do TMDB
// ---------------------------------------------------------------------------
// A chave é lida diretamente do ambiente do servidor.
// Não fica no HTML e não é salva no navegador.
function getTmdbApiKey() {
  return String(process.env.TMDB_API_KEY || '').trim();
}

// ---------------------------------------------------------------------------
// 0) Detecção de mobile (mesmo padrão usado no projeto do Last.fm)
// ---------------------------------------------------------------------------
// Detecta celular pelo User-Agent (não tablets: iPad e Android sem "Mobile"
// continuam na versão desktop, que tem espaço de sobra pra tela grande).
// Mesmo padrão usado por CDNs/servidores pra diferenciar phone de tablet.
const MOBILE_USER_AGENT_REGEX = /Android.+Mobile|iPhone|iPod|Windows Phone|BlackBerry|IEMobile|Opera Mini/i;

function isMobileRequest(req) {
  const userAgent = req.headers['user-agent'] || '';
  return MOBILE_USER_AGENT_REGEX.test(userAgent);
}

function pickIndexFile(req) {
  const fileName = isMobileRequest(req) ? 'index-mobile.html' : 'index.html';
  return path.join(__dirname, 'public', fileName);
}

// Precisa vir ANTES do express.static: senão o static sempre serve o
// public/index.html padrão pra "/" e essa rota nunca seria alcançada.
app.get('/', (req, res) => {
  res.sendFile(pickIndexFile(req));
});


// ---------------------------------------------------------------------------
// 1) Editor visual estático
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));


// ---------------------------------------------------------------------------
// 1.5) Status da API do TMDB
// ---------------------------------------------------------------------------
app.get('/api/tmdb/status', (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    configured: !!getTmdbApiKey()
  });
});


// ---------------------------------------------------------------------------
// 1.6) Proxy da API do TMDB
// ---------------------------------------------------------------------------
// O navegador chama:
//
//   /api/tmdb/search/multi
//   /api/tmdb/movie/123/images
//   /api/tmdb/tv/123/images
//
// O servidor acrescenta a TMDB_API_KEY.
// ---------------------------------------------------------------------------
app.get('/api/tmdb/*', async (req, res) => {
  const apiKey = getTmdbApiKey();

  if (!apiKey) {
    console.error('TMDB_API_KEY não configurada no ambiente do servidor.');

    return res.status(503).json({
      error: 'TMDB_API_KEY não configurada no servidor.'
    });
  }

  const apiPath = req.params[0];

  if (!apiPath) {
    return res.status(400).json({
      error: 'Rota da API do TMDB ausente.'
    });
  }

  // Monta a URL da API do TMDB.
  const upstreamUrl = new URL(`${TMDB_API_BASE}/${apiPath}`);

  // Repassa os parâmetros enviados pelo navegador,
  // mas nunca permite que ele forneça a própria api_key.
  for (const [key, value] of Object.entries(req.query)) {
    if (key !== 'api_key' && typeof value === 'string') {
      upstreamUrl.searchParams.set(key, value);
    }
  }

  // A chave vem SOMENTE do Render.
  upstreamUrl.searchParams.set('api_key', apiKey);

  console.log(
    `TMDB request: ${req.method} /api/tmdb/${apiPath}`
  );

  try {
    const upstreamResponse = await fetch(upstreamUrl);

    const body = await upstreamResponse.text();

    console.log(
      `TMDB response: ${upstreamResponse.status} /${apiPath}`
    );

    res.status(upstreamResponse.status);

    res.set(
      'Content-Type',
      upstreamResponse.headers.get('content-type') ||
      'application/json'
    );

    res.set('Cache-Control', 'public, max-age=300');

    res.send(body);

  } catch (error) {
    console.error('Erro no proxy da API do TMDB:', error);

    res.status(502).json({
      error: 'Erro ao consultar o TMDB.'
    });
  }
});


// ---------------------------------------------------------------------------
// Página em branco usada pelo Puppeteer
// ---------------------------------------------------------------------------
app.get('/__puppeteer-blank__', (req, res) => {
  res
    .type('html')
    .send('<!doctype html><html><head></head><body></body></html>');
});


// ---------------------------------------------------------------------------
// 2) Proxy de imagens do TMDB
// ---------------------------------------------------------------------------
app.get('/tmdb-image/:size/*', async (req, res) => {
  const { size } = req.params;
  const imagePath = req.params[0];

  if (!ALLOWED_TMDB_SIZES.has(size)) {
    return res
      .status(400)
      .send('Tamanho de imagem do TMDB não suportado.');
  }

  if (!imagePath) {
    return res
      .status(400)
      .send('Caminho da imagem do TMDB ausente.');
  }

  const upstreamUrl =
    `${TMDB_IMAGE_BASE}/${size}/${imagePath}`;

  // O card e os previews da aba Imagens pedem a MESMA imagem quase ao
  // mesmo tempo (uma pro card, outra pro preview em miniatura). Isso
  // dobra a carga sobre esse proxy justamente no pico, e qualquer falha
  // passageira do TMDB (timeout, hiccup de rede) fazia o preview ficar
  // travado em branco/preto pra sempre, já que o cliente não tinha
  // retry. Aqui adicionamos um timeout curto + 1 nova tentativa, pra
  // absorver esses hiccups sem exigir nada do lado do navegador.
  async function fetchUpstream(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    let upstreamResponse;
    try {
      upstreamResponse = await fetchUpstream(upstreamUrl, 8000);
    } catch (firstError) {
      // Primeira tentativa falhou (timeout/erro de rede) — tenta mais
      // uma vez antes de desistir.
      upstreamResponse = await fetchUpstream(upstreamUrl, 8000);
    }

    if (!upstreamResponse.ok) {
      return res
        .status(upstreamResponse.status)
        .send('Não foi possível obter a imagem do TMDB.');
    }

    const contentType =
      upstreamResponse.headers.get('content-type') ||
      'image/jpeg';

    const arrayBuffer =
      await upstreamResponse.arrayBuffer();

    res.set('Content-Type', contentType);

    res.set(
      'Cache-Control',
      'public, max-age=86400, immutable'
    );

    res.send(Buffer.from(arrayBuffer));

  } catch (error) {
    console.error('Erro no proxy do TMDB:', error);

    res
      .status(502)
      .send('Erro ao buscar imagem do TMDB.');
  }
});


// ---------------------------------------------------------------------------
// 3) Puppeteer
// ---------------------------------------------------------------------------
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
    });
  }

  return browserPromise;
}


// ---------------------------------------------------------------------------
// Corpo da requisição de /download-image
// ---------------------------------------------------------------------------
app.use(
  '/download-image',
  express.text({
    type: 'text/html',
    limit: '50mb'
  })
);


app.post('/download-image', async (req, res) => {
  const html = req.body;

  if (!html || typeof html !== 'string') {
    return res
      .status(400)
      .send('HTML do card não foi recebido.');
  }

  let page;

  try {
    const browser = await getBrowser();

    page = await browser.newPage();

    await page.setViewport({
      width: 1600,
      height: 1200,
      deviceScaleFactor: 4,
    });

    await page.goto(
      `http://localhost:${PORT}/__puppeteer-blank__`,
      {
        waitUntil: 'domcontentloaded',
      }
    );

    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Aguarda fontes.
    await page.evaluate(() => {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready;
      }

      return Promise.resolve();
    });

    // Aguarda imagens.
    await page.evaluate(() => {
      const images = Array.from(document.images);

      return Promise.all(
        images.map((img) => {
          if (
            img.complete &&
            img.naturalWidth > 0
          ) {
            return Promise.resolve();
          }

          return new Promise((resolve) => {
            img.addEventListener(
              'load',
              resolve,
              { once: true }
            );

            img.addEventListener(
              'error',
              resolve,
              { once: true }
            );
          });
        })
      );
    });

    // Pequena folga para filtros/transições CSS.
    await new Promise((resolve) =>
      setTimeout(resolve, 150)
    );

    const cardHandle = await page.$('#canvas');

    if (!cardHandle) {
      throw new Error(
        'Elemento do card (#canvas) não foi encontrado no HTML recebido.'
      );
    }

    const pngBuffer =
      await cardHandle.screenshot({
        type: 'png'
      });

    res.set(
      'Content-Type',
      'image/png'
    );

    res.set(
      'Content-Disposition',
      'attachment; filename="movie-card-1440x2560.png"'
    );

    res.send(pngBuffer);

  } catch (error) {
    console.error(
      'Erro ao gerar a imagem do card:',
      error
    );

    res
      .status(500)
      .send(
        'Erro ao gerar a imagem: ' +
        error.message
      );

  } finally {
    if (page) {
      await page.close();
    }
  }
});


// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(
    `Servidor rodando em http://localhost:${PORT}`
  );

  console.log(
    `TMDB_API_KEY configurada: ${!!getTmdbApiKey()}`
  );
});


// ---------------------------------------------------------------------------
// Encerramento
// ---------------------------------------------------------------------------
process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }

  process.exit(0);
});
