const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  req.setTimeout(300000);
  res.setTimeout(300000);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'CreoGen server running' });
});

async function callGemini(apiKey, model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240000);

  const generationConfig = {
    responseModalities: ['IMAGE', 'TEXT'],
    candidateCount: 1,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig
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

function buildBasePrompt({ line1, line2, cta, visual, hasReference }) {
  const referenceNote = hasReference
    ? 'Use the provided reference image for composition and overall layout. Arrange elements in a similar way — recreate the feel and layout of the reference, but with the new content specified below.\n\n'
    : '';

  const textBlock = [
    line1 ? `  * Headline (large, bold, uppercase): "${line1}"` : '',
    line2 ? `  * Subheadline (medium size): "${line2}"` : '',
    cta   ? `  * CTA button: "${cta}"` : '',
  ].filter(Boolean).join('\n');

  const visualBlock = visual ? `\nVISUAL BLOCK:\n- Position: right part of the image\n- Content: ${visual}` : '';

  return `${referenceNote}You are a professional advertising banner designer.
Create a high-quality advertising banner in 16:9 horizontal format.

TEXT BLOCK:
- Position: left part of the image
- Content:
${textBlock}
${visualBlock}

The text block and visual block are part of one cohesive composition.
Seamless full-bleed background that flows naturally across the entire image.
Sharp readable text, good contrast, no watermarks.
Professional advertising quality for major ad networks.`;
}

function buildResizePrompt(ratio) {
  const ratioNames = {
    '1:1':    '1:1 square',
    '9:16':   '9:16 vertical',
    '1.91:1': '1.91:1',
    '4:3':    '4:3',
    '3:4':    '3:4 vertical',
  };
  return `Adapt this banner to ${ratioNames[ratio]} format. Redistribute all elements compositionally correct for the new dimensions.`;
}

// Очередь форматов — строго последовательно
const QUEUE = [
  { ratio: '16:9',   aspectRatio: '16:9',  label: '16:9' },
  { ratio: '1:1',    aspectRatio: '1:1',   label: '1:1' },
  { ratio: '9:16',   aspectRatio: '9:16',  label: '9:16' },
  { ratio: '1.91:1', aspectRatio: '16:9',  label: '1.91:1' },
  { ratio: '4:3',    aspectRatio: '4:3',   label: '4:3' },
  { ratio: '3:4',    aspectRatio: '3:4',   label: '3:4' },
];

app.post('/api/generate-all', async (req, res) => {
  const { apiKey, model, line1, line2, cta, visual, referenceImage, referenceMimeType } = req.body;

  if (!apiKey || !line1) {
    return res.status(400).json({ error: 'Нужны: apiKey, line1' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch(e) {}
  };

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch(e) { clearInterval(keepalive); }
  }, 15000);

  const selectedModel = model || 'gemini-3.1-flash-image-preview';
  let baseImage = null;

  try {
    for (let i = 0; i < QUEUE.length; i++) {
      const { ratio, aspectRatio, label } = QUEUE[i];

      send('progress', {
        step: i + 1,
        total: QUEUE.length,
        message: `Генерирую ${label}...`,
        ratio
      });

      try {
        let parts;

        if (ratio === '16:9') {
          // Базовый запрос
          parts = [];
          if (referenceImage && referenceMimeType) {
            parts.push({ inlineData: { mimeType: referenceMimeType, data: referenceImage } });
          }
          parts.push({ text: buildBasePrompt({ line1, line2, cta, visual, hasReference: !!referenceImage }) });
        } else {
          // Ресайз на основе базового
          parts = [
            { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
            { text: buildResizePrompt(ratio) }
          ];
        }

        const image = await callGemini(apiKey, selectedModel, parts);

        if (ratio === '16:9') baseImage = image;

        send('image', { ratio, image });

      } catch(err) {
        send('error', { ratio, message: err.message });
        // Если базовый не сгенерился — останавливаем всё
        if (ratio === '16:9') {
          send('done', { message: 'Ошибка базовой генерации' });
          return;
        }
      }
    }

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

server.timeout = 300000;
server.keepAliveTimeout = 300000;
server.headersTimeout = 310000;
