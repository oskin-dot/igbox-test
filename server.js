const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Увеличиваем таймаут сервера до 5 минут
app.use((req, res, next) => {
  req.setTimeout(300000);
  res.setTimeout(300000);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'CreoGen server running' });
});

// ─────────────────────────────────────────
// Запрос к Gemini (generateContent)
// ─────────────────────────────────────────
async function callGemini(apiKey, model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240000); // 4 мин таймаут

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          candidateCount: 1,
        }
      }),
      signal: controller.signal
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Ошибка Google API');

    const parts_out = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts_out.find(p => p.inlineData?.data);
    if (!imagePart) {
      const textPart = parts_out.find(p => p.text);
      throw new Error(textPart?.text || 'Модель не вернула изображение');
    }

    return {
      data: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || 'image/png'
    };

  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────
// Промпты
// ─────────────────────────────────────────
function buildBasePrompt({ line1, line2, cta, visual }) {
  const textBlock = [
    line1 ? `  * Headline (large, bold, uppercase): "${line1}"` : '',
    line2 ? `  * Subheadline (medium size): "${line2}"` : '',
    cta   ? `  * CTA button with text: "${cta}"` : '',
  ].filter(Boolean).join('\n');

  const visualBlock = visual
    ? `- Right side (60% of image): ${visual}`
    : '';

  return `You are a professional advertising banner designer.

TASK: Create a high-quality advertising banner in 16:9 horizontal format.

LAYOUT:
- Left side (40% of image): text area
${textBlock}
${visualBlock}

TECHNICAL REQUIREMENTS:
- All text must be sharp, clearly readable, well-designed
- Text should have good contrast against the background
- No additional text, labels or watermarks beyond what is specified
- Professional advertising quality, suitable for major ad networks
- High resolution, crisp edges`;
}

function buildResizePrompt(ratio) {
  const layouts = {
    '1:1': `Adapt this advertising banner to 1:1 square format.
Redistribute all elements compositionally correct for the new dimensions.
- Top area (35%): headline and subheadline, centered
- Middle (20%): CTA button, centered
- Bottom (45%): main visual element
Keep all original text exactly as-is. Keep same style and colors. No watermarks.`,

    '9:16': `Adapt this advertising banner to 9:16 vertical format (Stories/Reels).
Redistribute all elements compositionally correct for the new dimensions.
- Top (20%): headline, centered, large
- Upper-middle (15%): subheadline, centered
- Center (40%): main visual, large and impactful
- Bottom (25%): CTA button, centered
Keep all original text exactly as-is. Keep same style and colors. No watermarks.`,

    '1.91:1': `Adapt this advertising banner to 1.91:1 format (1200x628, Facebook/Google feed).
Redistribute all elements compositionally correct for the new dimensions.
Keep the horizontal layout similar to 16:9 but slightly more compact.
Keep all original text exactly as-is. Keep same style and colors. No watermarks.`,

    '4:3': `Adapt this advertising banner to 4:3 format (1024x768).
Redistribute all elements compositionally correct for the new dimensions.
Keep all original text exactly as-is. Keep same style and colors. No watermarks.`,

    '3:4': `Adapt this advertising banner to 3:4 vertical format (768x1024).
Redistribute all elements compositionally correct for the new dimensions.
Keep all original text exactly as-is. Keep same style and colors. No watermarks.`,
  };
  return layouts[ratio] || '';
}

// ─────────────────────────────────────────
// ENDPOINT: Генерация всех форматов
// ─────────────────────────────────────────
app.post('/api/generate-all', async (req, res) => {
  const { apiKey, model, line1, line2, cta, visual } = req.body;

  if (!apiKey || !line1) {
    return res.status(400).json({ error: 'Нужны: apiKey, line1' });
  }

  // SSE заголовки
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // отключаем буферизацию nginx

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch(e) {}
  };

  // Keepalive пинг каждые 15 секунд чтобы Render не обрывал соединение
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch(e) {
      clearInterval(keepalive);
    }
  }, 15000);

  const selectedModel = model || 'gemini-3.1-flash-image-preview';

  try {
    // ── Шаг 1: базовый 16:9 ──
    send('progress', { step: 1, total: 6, message: 'Генерирую базовый 16:9...' });

    const baseImage = await callGemini(apiKey, selectedModel, [
      { text: buildBasePrompt({ line1, line2, cta, visual }) }
    ]);

    send('image', { ratio: '16:9', image: baseImage });
    send('progress', { step: 2, total: 6, message: 'Адаптирую 1:1...' });

    // ── Шаг 2: 1:1 ──
    try {
      const square = await callGemini(apiKey, selectedModel, [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('1:1') }
      ]);
      send('image', { ratio: '1:1', image: square });
    } catch(e) {
      send('error', { ratio: '1:1', message: e.message });
    }

    send('progress', { step: 3, total: 6, message: 'Адаптирую 9:16...' });

    // ── Шаг 3: 9:16 ──
    try {
      const vertical = await callGemini(apiKey, selectedModel, [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('9:16') }
      ]);
      send('image', { ratio: '9:16', image: vertical });
    } catch(e) {
      send('error', { ratio: '9:16', message: e.message });
    }

    send('progress', { step: 4, total: 6, message: 'Адаптирую 1.91:1...' });

    // ── Шаг 4: 1.91:1 ──
    try {
      const feed = await callGemini(apiKey, selectedModel, [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('1.91:1') }
      ]);
      send('image', { ratio: '1.91:1', image: feed });
    } catch(e) {
      send('error', { ratio: '1.91:1', message: e.message });
    }

    send('progress', { step: 5, total: 6, message: 'Адаптирую 4:3 и 3:4...' });

    // ── Шаг 5: 4:3 и 3:4 параллельно ──
    const [landscape43, portrait34] = await Promise.allSettled([
      callGemini(apiKey, selectedModel, [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('4:3') }
      ]),
      callGemini(apiKey, selectedModel, [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('3:4') }
      ])
    ]);

    if (landscape43.status === 'fulfilled') send('image', { ratio: '4:3', image: landscape43.value });
    else send('error', { ratio: '4:3', message: landscape43.reason?.message });

    if (portrait34.status === 'fulfilled') send('image', { ratio: '3:4', image: portrait34.value });
    else send('error', { ratio: '3:4', message: portrait34.reason?.message });

    send('progress', { step: 6, total: 6, message: '✅ Все форматы готовы!' });
    send('done', { message: 'Готово!' });

  } catch (err) {
    console.error('Generate error:', err.message);
    send('error', { message: err.message });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

const server = app.listen(PORT, () => {
  console.log(`CreoGen server running on port ${PORT}`);
});

// Увеличиваем таймаут самого HTTP сервера
server.timeout = 300000;      // 5 минут
server.keepAliveTimeout = 300000;
server.headersTimeout = 310000;
