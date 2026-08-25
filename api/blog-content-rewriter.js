import { GoogleGenAI } from '@google/genai';

const allowCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const cleanJson = (text = '') => JSON.parse(text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim() || '{}');

async function extractUrl(url) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const response = await fetch(target, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BlogContentRewriter/1.0)', Accept: 'text/html' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Could not fetch the article (HTTP ${response.status}). Paste the article text instead.`);
  const html = await response.text();
  const title = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Extracted Article')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const content = html
    .replace(/<(script|style|nav|footer|header|aside|form|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h2[^>]*>/gi, '\n\n## ').replace(/<h3[^>]*>/gi, '\n\n### ')
    .replace(/<\/(h1|h2|h3|p|li|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n* ').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (content.length < 100) throw new Error('The extracted article was too short or protected. Paste the article text instead.');
  return { title, content: `# ${title}\n\n${content}` };
}

export default async function handler(req, res) {
  allowCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action } = req.body || {};
    if (action === 'extract-url') return res.status(200).json(await extractUrl(req.body.url));

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY is missing in gemini-proxy-2.' });
    const ai = new GoogleGenAI({ apiKey });

    if (action === 'analyze-brand') {
      const rawGuidelines = String(req.body.rawGuidelines || '').trim();
      if (!rawGuidelines) return res.status(400).json({ error: 'Guidelines text is required.' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Extract these editorial guidelines as JSON with keys tone, preferredTerms, prohibitedTerms, spelling, audience, formattingRules, ctaGuidance, styleRestrictions. Array fields must be arrays.\n\n${rawGuidelines}`,
        config: { responseMimeType: 'application/json', temperature: 0.1 },
      });
      return res.status(200).json({ ...cleanJson(response.text), rawText: rawGuidelines, isCustom: true, isSupplied: true });
    }

    if (action === 'refine-section') {
      const { sectionTitle, content, customPrompt, brandGuidelines } = req.body;
      if (!content) return res.status(400).json({ error: 'Section content is required.' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Revise this article section. Follow the instruction and return only revised Markdown. Preserve every Markdown link, image placeholder, and fact-check flag. Do not invent facts.\nInstruction: ${customPrompt || 'Improve clarity and flow'}\nSpelling: ${brandGuidelines?.spelling || 'standard'}\nProhibited terms: ${(brandGuidelines?.prohibitedTerms || []).join(', ')}\nHeading: ${sectionTitle || ''}\n\n${content}`,
        config: { temperature: 0.2 },
      });
      return res.status(200).json({ refinedContent: response.text?.trim() || content });
    }

    if (action !== 'rewrite-article') return res.status(400).json({ error: 'Unknown action.' });
    const b = req.body;
    if (!String(b.article || '').trim()) return res.status(400).json({ error: 'Article content is required.' });
    const prompt = `You are a senior editorial rewriter. Rewrite the supplied article while preserving every URL and image reference. Never invent facts, prices, hours, reviews, statistics, or quotes. Mark time-sensitive claims with [FACT CHECK REQUIRED: reason].

Rules:
- Rewrite depth: ${b.rewriteLevel || 'rewrite'}
- Expansions: ${(b.selectedExpansions || []).join(', ') || 'none'}
- Editorial instructions: ${b.editorialInstructions || 'none'}
- Tone: ${b.brandGuidelines?.tone || 'clear editorial'}
- Spelling: ${b.brandGuidelines?.spelling || 'standard'}
- Preferred terms: ${(b.brandGuidelines?.preferredTerms || []).join(', ')}
- Prohibited terms: ${(b.brandGuidelines?.prohibitedTerms || []).join(', ')}
- Audience: ${b.targetAudience || b.brandGuidelines?.audience || 'general readers'}
- Topic: ${b.primaryTopic || 'not specified'}; destination: ${b.destination || 'not specified'}; target query: ${b.preferredQuery || 'not specified'}; objective: ${b.contentObjective || 'improve usefulness'}

Return valid JSON only with: title, rewrittenArticle, sections, links, images, factChecks, brandChecks, entities, changes. sections items require id, heading, level, content, originalContent, changeType. links preserve exact URLs and require id, originalAnchor, originalUrl, newAnchor, newPlacement, isInternal, status, reason. images require id, url, originalSection, newSection, altText, caption, credit, status. factChecks require id, statement, reason, type, severity, section. brandChecks require id, category, name, status, details, examples. entities require id, name, type, existingCoverage, addedContext, relevantSection, verificationRequired. changes requires sectionsRetained, sectionsRewritten, sectionsExpanded, sectionsMoved, sectionsRemoved, newSections, linksChangedCount, imagesMovedCount, factsToVerifyCount, brandCorrectionsCount, summary.

ARTICLE:\n${b.article}`;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash', contents: prompt,
      config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 8192 },
    });
    const result = cleanJson(response.text);
    if (!result.rewrittenArticle) throw new Error('Gemini returned an incomplete rewrite. Please try again with a shorter article.');
    return res.status(200).json(result);
  } catch (error) {
    console.error('blog-content-rewriter:', error);
    const message = error?.message || 'The rewrite request failed.';
    return res.status(/fetch|extract|article.*required/i.test(message) ? 422 : 500).json({ error: message });
  }
}
