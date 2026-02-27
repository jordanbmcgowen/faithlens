export async function onRequestPost(context: {
  request: Request;
  env: { ANTHROPIC_API_KEY?: string };
}): Promise<Response> {
  try {
    const { request, env } = context;

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return json({ error: 'Expected application/json' }, 415);
    }

    const body = (await request.json().catch(() => null)) as null | { question?: unknown };
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question) return json({ error: 'Missing question' }, 400);

    // If the key isn't set, return a clear error; the frontend will fall back to demo mode.
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'ANTHROPIC_API_KEY not set' }, 503);
    }

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Use current Sonnet model per Anthropic docs.
        model: 'claude-sonnet-4-6',
        max_tokens: 1600,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: question }],
      }),
    });

    const raw = await anthropicResp.text();
    if (!anthropicResp.ok) {
      return json({ error: 'Anthropic API error', status: anthropicResp.status, details: safeJson(raw) }, 502);
    }

    const parsed = safeJson(raw) as any;

    const text = parsed?.content?.[0]?.text;
    if (typeof text !== 'string') {
      return json({ error: 'Unexpected Anthropic response shape' }, 502);
    }

    const answer = extractJsonObject(text);
    if (!answer || !Array.isArray((answer as any).traditions)) {
      return json({ error: 'Model did not return expected JSON' }, 502);
    }

    const enriched = await enrichWithScriptureApis(answer as any);

    return json(enriched, 200);
  } catch (err) {
    return json({ error: 'Unhandled error', details: String(err) }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractJsonObject(text: string): unknown {
  // Try direct parse first.
  const direct = safeJson(text);
  if (direct && typeof direct === 'object') return direct;

  // Look for a ```json ... ``` fenced block and parse its contents.
  const fencedMatch = text.match(/```json([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    const inner = fencedMatch[1].trim();
    const parsedInner = safeJson(inner);
    if (parsedInner && typeof parsedInner === 'object') return parsedInner;
  }

  // If there is any fenced block without "json" language tag.
  const genericFence = text.match(/```([\s\S]*?)```/);
  if (genericFence && genericFence[1]) {
    const inner = genericFence[1].trim();
    const parsedInner = safeJson(inner);
    if (parsedInner && typeof parsedInner === 'object') return parsedInner;
  }

  // Fallback: grab substring between first '{' and last '}'.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last >= first) {
    const slice = text.slice(first, last + 1);
    const parsedSlice = safeJson(slice);
    if (parsedSlice && typeof parsedSlice === 'object') return parsedSlice;
  }

  return direct;
}

async function enrichWithScriptureApis(answer: { traditions: any[] }): Promise<{ traditions: any[] }> {
  if (!answer?.traditions || !Array.isArray(answer.traditions)) return answer;

  const traditions = await Promise.all(
    answer.traditions.map(async (t) => {
      if (!t || typeof t !== 'object') return t;

      // Christianity: ground simple Bible citations via a public Bible API.
      // Pattern examples: "John 3:16", "1 John 4:8", "Romans 8:28", "Psalm 23:1-3".
      if ((t.id === 'christianity' || t.id === 'Christianity') && typeof t.citation === 'string') {
        const citation = t.citation.trim();
        const biblePattern = /^[1-3]?\s?[A-Za-z ]+\s+\d+:\d+(-\d+)?$/;
        if (biblePattern.test(citation)) {
          const verse = await fetchBibleVerse(citation);
          if (verse) {
            return {
              ...t,
              quote: verse,
            };
          }
        }
      }

      // First example integration: Judaism via Sefaria (no API key required).
      // Keep quotes short and verse-like: only override when the citation looks like a Tanakh verse
      // such as "Genesis 1:27" or "Isaiah 40:31" (Book Chapter:Verse or Chapter:Verse-Range).
      if ((t.id === 'judaism' || t.id === 'Judaism') && typeof t.citation === 'string') {
        const citation = t.citation.trim();
        const tanakhPattern = /^[A-Za-z ]+\s+\d+:\d+(-\d+)?$/;
        if (!tanakhPattern.test(citation)) {
          return t;
        }

        const sefariaQuote = await fetchSefariaQuote(citation);
        if (sefariaQuote) {
          return {
            ...t,
            quote: sefariaQuote,
          };
        }
      }

      return t;
    }),
  );

  return { ...answer, traditions };
}

async function fetchBibleVerse(citation: string): Promise<string | null> {
  try {
    // Use bible-api.com with KJV by default.
    // Example: "John 3:16" -> "john 3:16"
    const ref = encodeURIComponent(citation.toLowerCase());
    const url = `https://bible-api.com/${ref}?translation=kjv`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;

    const text: string | undefined = typeof data?.text === 'string' ? data.text : undefined;
    if (!text) return null;

    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length > 260 ? trimmed.slice(0, 257) + '…' : trimmed;
  } catch {
    return null;
  }
}

async function fetchSefariaQuote(citation: string): Promise<string | null> {
  try {
    // Basic normalization: "Genesis 1:1" -> "Genesis.1.1"
    const normalized = citation.replace(/\s+/g, '.').replace(':', '.');
    const url = `https://www.sefaria.org/api/texts/${encodeURIComponent(normalized)}?context=0&commentary=0`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;

    const textArr = Array.isArray(data?.text) ? data.text as string[] : undefined;
    if (textArr && textArr.length > 0) {
      // Use only the first verse and keep it concise like the other traditions.
      const verse = String(textArr[0]).trim();
      return verse.length > 260 ? verse.slice(0, 257) + '…' : verse;
    }

    const heArr = Array.isArray(data?.he) ? data.he as string[] : undefined;
    if (heArr && heArr.length > 0) {
      const verse = String(heArr[0]).trim();
      return verse.length > 260 ? verse.slice(0, 257) + '…' : verse;
    }

    return null;
  } catch {
    return null;
  }
}

function buildSystemPrompt(): string {
  return `You are FaithLens, a multi-tradition wisdom engine. When the user asks a question, you respond with the perspective of eight distinct traditions, each grounded in primary scripture and texts. You are knowledgeable, respectful, and precise.

The user may ask about ANY topic — including things that are only loosely or not at all connected to faith, ethics, or religion (for example: "Why should we sleep?" or "How do I clean my room?"). You MUST still respond for every tradition using the JSON format below. If a topic is not clearly or directly addressed in that tradition's primary sources, you must:
- Say so explicitly in the response (e.g. "This question is not directly discussed in the core scriptures of this tradition, but...")
- Offer, at most, a brief adjacent insight that is honest about the limits of the sources
- Choose either no quote at all, or a verse/passage that is genuinely adjacent (health, care of the body, rest, etc.), and be transparent in the wording that it is an application or analogy, not a direct teaching on the exact topic.

For EACH of the eight traditions below, provide:
1. A 3-5 sentence response articulating the tradition's perspective clearly and in plain language
2. One specific scripture/text quotation that anchors the response (exact quote in quotes)
3. The citation for that quote (book, chapter, verse or equivalent)

Traditions to cover (use these exact ids):
1. CHRISTIANITY — id: christianity — cite Bible (prefer NT but also use OT where fitting)
2. ISLAM — id: islam — cite Quran (Surah:Ayah) or an authentic Hadith (Bukhari, Muslim, Abu Dawud, etc.)
3. JUDAISM — id: judaism — cite Torah, Talmud, Mishnah, or Tanakh with precise reference, formatted like "Genesis 1:1" or "Berakhot 32b" (compatible with Sefaria refs)
4. HINDUISM — id: hinduism — cite Bhagavad Gita, Upanishads, or Vedas with chapter/verse
5. BUDDHISM — id: buddhism — cite Pali Canon (Dhammapada, Majjhima Nikaya, etc.) with precise reference
6. SIKHISM — id: sikhism — cite Guru Granth Sahib with Ang (page) number
7. TAOISM — id: taoism — cite Tao Te Ching (chapter number) or Zhuangzi
8. SECULAR/PHILOSOPHICAL — id: secular — synthesize Stoic, Existentialist, or Humanist thinkers (cite one: Seneca, Marcus Aurelius, Epictetus, Sartre, Camus, Viktor Frankl, etc.)

Return your response as valid JSON in this exact structure:
{
  "traditions": [
    {
      "id": "christianity",
      "response": "...",
      "quote": "...",
      "citation": "..."
    }
  ]
}

Rules:
- Be accurate to each tradition's actual theology. Do not water down or syncretize.
- Quote scripture precisely. Do not paraphrase scripture as if it's a quote.
- If uncertain of exact wording, do NOT invent a quote. Instead: give a short paraphrase and set quote to "(paraphrase)", still providing the best citation you can.
- Keep each response concise but substantive.
- Return ONLY the JSON object. No preamble, no explanation outside the JSON.`;
}
