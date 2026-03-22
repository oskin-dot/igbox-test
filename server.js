const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'IGBOX server running' });
});

// ─────────────────────────────────────────
// Вспомогательная функция — запрос к Gemini
// ─────────────────────────────────────────
async function callGemini(apiKey, model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      candidateCount: 1,
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error?.message || 'Ошибка Google API');
  }

  // Достаём картинку из ответа
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
}

// ─────────────────────────────────────────
// Строим промпт для базового 16:9
// ─────────────────────────────────────────
function buildBasePrompt({ line1, line2, cta, visual, style }) {
  return `You are a professional iGaming advertising banner designer.

TASK: Create a high-quality advertising banner (16:9 horizontal format).

LAYOUT:
- Left side (40% of image): Text area with dark semi-transparent background
  * TOP: Bold headline in large uppercase letters: "${line1}"
  * MIDDLE: Subheadline text: "${line2}"  
  * BOTTOM: Bright CTA button with text: "${cta}"
- Right side (60% of image): Visual area
  * Content: ${visual}

STYLE:
- Overall mood: ${style}
- Background: Dark luxury casino atmosphere
- Lighting: Dramatic cinematic, deep shadows, neon accents
- Colors: Deep purple, gold, emerald on dark backgrounds
- Quality: Ultra high quality, photorealistic, advertising grade

STRICT RULES:
- Text must be clearly readable, sharp and well-designed
- No additional text or logos beyond what is specified
- No watermarks
- Professional advertising quality`;
}

// ─────────────────────────────────────────
// Строим промпт для адаптации под новый размер
// ─────────────────────────────────────────
function buildResizePrompt(ratio) {
  const layouts = {
    '1:1': `Adapt this iGaming banner to a 1:1 square format.
LAYOUT RULES for square:
- Top area (35%): Headline and subheadline text, centered
- Middle area (30%): CTA button, centered
- Bottom area (35%): Visual elements (coins, casino elements etc.)
Keep all original text content exactly the same.
Keep the same style, colors, lighting and atmosphere.
Recompose elements to fit square format naturally.
Result must look like a professionally designed social media post.`,

    '9:16': `Adapt this iGaming banner to a 9:16 vertical format (Stories/Reels).
LAYOUT RULES for vertical:
- Top area (25%): Headline text, centered, large
- Upper-middle (15%): Subheadline text, centered
- Center (40%): Large visual elements filling the frame dramatically
- Bottom area (20%): CTA button, centered, prominent
Keep all original text content exactly the same.
Keep the same style, colors, lighting and atmosphere.
Make visual elements large and impactful for mobile viewing.
Result must look like a professionally designed Story ad.`
  };

  return layouts[ratio] || '';
}

// ─────────────────────────────────────────
// ENDPOINT: Генерация базового баннера (16:9)
// ─────────────────────────────────────────
app.post('/api/generate-base', async (req, res) => {
  const { apiKey, model, line1, line2, cta, visual, style } = req.body;

  if (!apiKey || !line1 || !visual) {
    return res.status(400).json({ error: 'Нужны: apiKey, line1, visual' });
  }

  try {
    const prompt = buildBasePrompt({ line1, line2, cta, visual, style: style || 'Dark Luxury' });
    const image = await callGemini(apiKey, model || 'gemini-3-pro-image-preview', [
      { text: prompt }
    ]);

    res.json({ image, ratio: '16:9' });
  } catch (err) {
    console.error('Base generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// ENDPOINT: Адаптация под новый размер
// ─────────────────────────────────────────
app.post('/api/resize', async (req, res) => {
  const { apiKey, model, imageData, imageMimeType, ratio } = req.body;

  if (!apiKey || !imageData || !ratio) {
    return res.status(400).json({ error: 'Нужны: apiKey, imageData, ratio' });
  }

  try {
    const prompt = buildResizePrompt(ratio);
    if (!prompt) {
      return res.status(400).json({ error: 'Неизвестный формат: ' + ratio });
    }

    const image = await callGemini(apiKey, model || 'gemini-3-pro-image-preview', [
      {
        inlineData: {
          mimeType: imageMimeType || 'image/png',
          data: imageData
        }
      },
      { text: prompt }
    ]);

    res.json({ image, ratio });
  } catch (err) {
    console.error('Resize error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────
// ENDPOINT: Полная генерация — все 3 размера
// ─────────────────────────────────────────
app.post('/api/generate-all', async (req, res) => {
  const { apiKey, model, line1, line2, cta, visual, style } = req.body;

  if (!apiKey || !line1 || !visual) {
    return res.status(400).json({ error: 'Нужны: apiKey, line1, visual' });
  }

  // Используем Server-Sent Events чтобы фронтенд получал картинки по мере готовности
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Шаг 1 — Генерируем базовый 16:9
    send('progress', { step: 1, total: 3, message: 'Генерирую базовый баннер 16:9...' });

    const prompt = buildBasePrompt({ line1, line2, cta, visual, style: style || 'Dark Luxury' });
    const baseImage = await callGemini(apiKey, model || 'gemini-3-pro-image-preview', [
      { text: prompt }
    ]);

    send('image', { ratio: '16:9', image: baseImage });
    send('progress', { step: 2, total: 3, message: 'Адаптирую под 1:1 и 9:16...' });

    // Шаг 2 — Параллельно адаптируем под 1:1 и 9:16
    const [square, vertical] = await Promise.allSettled([
      callGemini(apiKey, model || 'gemini-3-pro-image-preview', [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('1:1') }
      ]),
      callGemini(apiKey, model || 'gemini-3-pro-image-preview', [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('9:16') }
      ])
    ]);

    if (square.status === 'fulfilled') {
      send('image', { ratio: '1:1', image: square.value });
    } else {
      send('error', { ratio: '1:1', message: square.reason?.message });
    }

    if (vertical.status === 'fulfilled') {
      send('image', { ratio: '9:16', image: vertical.value });
    } else {
      send('error', { ratio: '9:16', message: vertical.reason?.message });
    }

    send('done', { message: 'Готово!' });

  } catch (err) {
    console.error('Generate-all error:', err.message);
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`IGBOX server running on port ${PORT}`);
});
