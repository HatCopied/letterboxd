// server.js
// ---------------------------------------------------------------------------
// Servidor Express + Puppeteer para o Movie Card.
//
// O que este arquivo faz:
//   1. Serve o editor visual (public/index.html) normalmente.
//   2. Faz proxy das imagens do TMDB em /tmdb-image/:size/*  (evita CORS e
//      mantém a arquitetura de rota já usada pelo HTML: w185, w342, w500,
//      w780, original).
//   3. Expõe POST /download-image: recebe o HTML clonado do card (enviado
//      pelo próprio front-end, que já faz document.documentElement.cloneNode
//      e remove os <script>), renderiza esse HTML num Chromium via Puppeteer
//      e tira um screenshot só do elemento #canvas (o card 360x640) usando
//      deviceScaleFactor 4 — resultando num PNG de 1440x2560 nítido, sem
//      jamais redimensionar um PNG pronto e sem usar html2canvas.
// ---------------------------------------------------------------------------

const path = require('path');
const dns = require('node:dns');
const express = require('express');
const puppeteer = require('puppeteer');

// Em algumas redes o IPv6 está mal configurado (roteador anuncia IPv6 mas
// não roteia de verdade), e o Node tenta IPv6 primeiro por padrão, travando
// por até 10s em cada requisição até cair pro IPv4. Isso resolve o padrão de
// timeout visto no proxy de imagens do TMDB.
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = process.env.PORT || 3000;

// Tamanhos de imagem do TMDB que o HTML já espera poder pedir.
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const ALLOWED_TMDB_SIZES = new Set(['w185', 'w342', 'w500', 'w780', 'original']);

// A chave do TMDB fica somente no ambiente do servidor (Render).
// Nunca é enviada de volta ao navegador.
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// ---------------------------------------------------------------------------
// 1) Editor visual estático
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));


// ---------------------------------------------------------------------------
// 1.5) Proxy da API do TMDB
// ---------------------------------------------------------------------------
// O front-end chama /api/tmdb/... e o servidor acrescenta a chave privada.
// Assim a TMDB_API_KEY não fica exposta no HTML/JavaScript público.
app.get('/api/tmdb/*', async (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(500).json({
      error: 'TMDB_API_KEY não está configurada no ambiente do servidor.',
    });
  }

  const apiPath = req.params[0];
  if (!apiPath) {
    return res.status(400).json({ error: 'Rota da API do TMDB ausente.' });
  }

  // Mantém a rota restrita ao caminho /3 do TMDB e repassa os parâmetros
  // usados pelo editor, mas nunca aceita api_key do navegador.
  const upstreamUrl = new URL(`${TMDB_API_BASE}/${apiPath}`);
  for (const [key, value] of Object.entries(req.query)) {
    if (key !== 'api_key' && typeof value === 'string') {
      upstreamUrl.searchParams.set(key, value);
    }
  }
  upstreamUrl.searchParams.set('api_key', TMDB_API_KEY);

  try {
    const upstreamResponse = await fetch(upstreamUrl);
    const body = await upstreamResponse.text();

    res.status(upstreamResponse.status);
    res.set('Content-Type', upstreamResponse.headers.get('content-type') || 'application/json');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(body);
  } catch (error) {
    console.error('Erro no proxy da API do TMDB:', error);
    res.status(502).json({ error: 'Erro ao consultar o TMDB.' });
  }
});

// Página em branco, na mesma origem do servidor, usada apenas para dar ao
// Puppeteer um "endereço" antes de injetar o HTML do card. Isso faz com que
// caminhos relativos como /tmdb-image/original/... resolvam corretamente,
// sem precisar carregar (e re-executar) o editor completo com sua busca ao
// TMDB, seu setInterval, etc.
app.get('/__puppeteer-blank__', (req, res) => {
  res.type('html').send('<!doctype html><html><head></head><body></body></html>');
});

// ---------------------------------------------------------------------------
// 2) Proxy de imagens do TMDB (evita CORS e expor a chave da API do TMDB
//    diretamente para o navegador na hora de baixar a imagem)
// ---------------------------------------------------------------------------
app.get('/tmdb-image/:size/*', async (req, res) => {
  const { size } = req.params;
  const imagePath = req.params[0];

  if (!ALLOWED_TMDB_SIZES.has(size)) {
    return res.status(400).send('Tamanho de imagem do TMDB não suportado.');
  }
  if (!imagePath) {
    return res.status(400).send('Caminho da imagem do TMDB ausente.');
  }

  const upstreamUrl = `${TMDB_IMAGE_BASE}/${size}/${imagePath}`;

  try {
    const upstreamResponse = await fetch(upstreamUrl);

    if (!upstreamResponse.ok) {
      return res
        .status(upstreamResponse.status)
        .send('Não foi possível obter a imagem do TMDB.');
    }

    const contentType = upstreamResponse.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await upstreamResponse.arrayBuffer();

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Erro no proxy do TMDB:', error);
    res.status(502).send('Erro ao buscar imagem no TMDB.');
  }
});

// ---------------------------------------------------------------------------
// 3) Puppeteer: instância única do navegador, reaproveitada entre downloads
// ---------------------------------------------------------------------------
let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browserPromise;
}

// Corpo da requisição de /download-image é o próprio HTML (texto puro),
// exatamente como o front-end já envia:
//   fetch('/download-image', {
//     method: 'POST',
//     headers: { 'Content-Type': 'text/html; charset=UTF-8' },
//     body: '<!doctype html>' + clone.outerHTML
//   })
app.use(
  '/download-image',
  express.text({ type: 'text/html', limit: '50mb' })
);

app.post('/download-image', async (req, res) => {
  const html = req.body;

  if (!html || typeof html !== 'string') {
    return res.status(400).send('HTML do card não foi recebido.');
  }

  let page;

  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Renderização em alta densidade: o card no HTML continua 360x640 (não
    // alteramos o CSS). O deviceScaleFactor 4 é o que faz o Chromium
    // renderizar internamente em 4x, então o screenshot do elemento sai em
    // 1440x2560 com texto, sombras e vetores nítidos.
    await page.setViewport({
      width: 1600,
      height: 1200,
      deviceScaleFactor: 4,
    });

    // Estabelece a origem http://localhost:PORT/ antes de injetar o HTML,
    // para que caminhos relativos (ex: /tmdb-image/original/xxx.jpg)
    // resolvam contra o nosso próprio servidor.
    await page.goto(`http://localhost:${PORT}/__puppeteer-blank__`, {
      waitUntil: 'domcontentloaded',
    });

    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Aguarda todas as fontes web terminarem de carregar.
    await page.evaluate(() => {
      if (document.fonts && document.fonts.ready) {
        return document.fonts.ready;
      }
      return Promise.resolve();
    });

    // Aguarda todas as <img> do documento (avatar, pôster, banner) estarem
    // completamente carregadas antes do screenshot.
    await page.evaluate(() => {
      const images = Array.from(document.images);
      return Promise.all(
        images.map((img) => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          });
        })
      );
    });

    // Pequena folga para transições/filtros CSS (brightness, overlay etc.)
    // terminarem de aplicar antes da captura.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const cardHandle = await page.$('#canvas');

    if (!cardHandle) {
      throw new Error(
        'Elemento do card (#canvas) não foi encontrado no HTML recebido.'
      );
    }

    const pngBuffer = await cardHandle.screenshot({ type: 'png' });

    res.set('Content-Type', 'image/png');
    res.set(
      'Content-Disposition',
      'attachment; filename="movie-card-1440x2560.png"'
    );
    res.send(pngBuffer);
  } catch (error) {
    console.error('Erro ao gerar a imagem do card:', error);
    res.status(500).send('Erro ao gerar a imagem: ' + error.message);
  } finally {
    if (page) {
      await page.close();
    }
  }
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
