const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'IGBOX server running' });
});

// Proxy endpoint — генерация картинок
app.post('/api/generate', async (req, res) => {
  const { apiKey, model, prompt, negative, ratio, count, referenceImage, referenceMimeType } = req.body;

  if (!apiKey || !model || !prompt) {
    return res.status(400).json({ error: 'Нужны: apiKey, model, prompt' });
  }

  try {
    // Строим промпт
    let fullPrompt = prompt;
    if (negative) fullPrompt += `\n\nAvoid: ${negative}`;
    if (ratio) fullPrompt += `\n\nAspect ratio: ${ratio}.`;

    // Строим content parts
    const parts = [];

    if (referenceImage && referenceMimeType) {
      parts.push({
        inlineData: {
          mimeType: referenceMimeType,
          data: referenceImage
        }
      });
      parts.push({ text: 'Use this image as a style reference. ' + fullPrompt });
    } else {
      parts.push({ text: fullPrompt });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        candidateCount: Math.min(parseInt(count) || 1, 4),
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || 'Ошибка Google API'
      });
    }

    // Достаём картинки из ответа
    const candidates = data.candidates || [];
    const images = [];

    candidates.forEach(candidate => {
      const parts = candidate?.content?.parts || [];
      parts.forEach(part => {
        if (part.inlineData?.data) {
          images.push({
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png'
          });
        }
      });
    });

    if (images.length === 0) {
      const textParts = candidates
        .flatMap(c => c?.content?.parts || [])
        .filter(p => p.text)
        .map(p => p.text)
        .join(' ');

      return res.status(400).json({
        error: textParts || 'Модель не вернула изображений. Попробуй изменить промпт.'
      });
    }

    res.json({ images, model, count: images.length });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`IGBOX server running on port ${PORT}`);
});
