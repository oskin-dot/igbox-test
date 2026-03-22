const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'CreoGen server running' });
});

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
}

function buildBasePrompt({ line1, line2, cta, visual }) {
  const textBlock = [
    line1 ? `  * Headline (large, bold, uppercase): "${line1}"` : '',
    line2 ? `  * Subheadline (medium size): "${line2}"` : '',
    cta   ? `  * CTA button with text: "${cta}"` : '',
  ].filter(Boolean).join('\n');

  return `You are a professional advertising banner designer.

TASK: Create a high-quality advertising banner in 16:9 horizontal format.

LAYOUT:
- Left side (40% of image): text area
${textBlock}
- Right side (60% of image): ${visual || 'dynamic advertising visual'}

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

LAYOUT RULES for square format:
- Top area (35%): headline and subheadline text, centered horizontally
- Middle area (20%): CTA button, centered
- Bottom area (45%): main visual element filling the space

REQUIREMENTS:
- Keep all original text content exactly as-is
- Keep the same visual style, colors and atmosphere from the original
- Recompose elements naturally for square format
- Result must look like a professionally designed social media ad post
- No additional text or watermarks`,

    '9:16': `Adapt this advertising banner to 9:16 vertical format (Stories / Reels).

LAYOUT RULES for vertical format:
- Top area (20%): headline text, centered, large and bold
- Upper-middle (15%): subheadline text, centered
- Center (40%): main visual element, large and impactful
- Bottom area (25%): CTA button centered, prominent

REQUIREMENTS:
- Keep all original text content exactly as-is
- Keep the same visual style, colors and atmosphere from the original
- Make the visual element large and dramatic for mobile viewing
- Result must look like a professionally designed Story or Reel ad
- No additional text or watermarks`
  };
  return layouts[ratio] || '';
}

app.post('/api/generate-all', async (req, res) => {
  const { apiKey, model, line1, line2, cta, visual } = req.body;

  if (!apiKey || !line1) {
    return res.status(400).json({ error: 'Нужны: apiKey, line1' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const selectedModel = model || 'gemini-3.1-flash-image-preview';

  try {
    send('progress', { step: 1, total: 3, message: 'Генерирую базовый баннер 16:9...' });

    const baseImage = await callGemini(apiKey, selectedModel, [
      { text: buildBasePrompt({ line1, line2, cta, visual }) }
    ]);

    send('image', { ratio: '16:9', image: baseImage });
    send('progress', { step: 2, total: 3, message: 'Адаптирую под 1:1 и 9:16...' });

    const [square, vertical] = await Promise.allSettled([
      callGemini(apiKey, selectedModel, [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('1:1') }
      ]),
      callGemini(apiKey, selectedModel, [
        { inlineData: { mimeType: baseImage.mimeType, data: baseImage.data } },
        { text: buildResizePrompt('9:16') }
      ])
    ]);

    if (square.status === 'fulfilled') send('image', { ratio: '1:1', image: square.value });
    else send('error', { ratio: '1:1', message: square.reason?.message });

    if (vertical.status === 'fulfilled') send('image', { ratio: '9:16', image: vertical.value });
    else send('error', { ratio: '9:16', message: vertical.reason?.message });

    send('done', { message: 'Готово!' });

  } catch (err) {
    console.error('Generate error:', err.message);
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`CreoGen server running on port ${PORT}`);
});
