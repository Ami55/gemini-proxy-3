import { GoogleGenAI } from '@google/genai';

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};
const parseJson = (text = '') => JSON.parse(text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim() || '{}');

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing in gemini-proxy-3.');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const body = req.body || {};

    if (body.action === 'synthesize-brief') {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `You are a senior SEO content strategist and evidence-led brief architect. Analyze the supplied evidence without inventing facts. Distinguish verified evidence from assumptions and placeholders. Recommend exactly one action from create_new_page, create_supporting_article, update_existing_page, add_new_section, or merge_overlapping_pages. Return JSON with executiveSummary, recommendedAction, justification, keyInformationGainOpportunities (string array), and criticalOutlineSections (objects containing heading, objective, questionsAnswered, keyPoints).\n\nProject:\n${JSON.stringify(body.project)}\n\nSite evidence:\n${JSON.stringify(body.siteEvidence)}\n\nQuery evidence:\n${JSON.stringify(body.queryEvidence)}\n\nCitation evidence:\n${JSON.stringify(body.citationEvidence)}`,
        config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 5000 },
      });
      return res.status(200).json({ status: 'success', synthesizedWith: 'gemini-2.5-flash', result: parseJson(response.text) });
    }

    if (body.action === 'generate-info-gain') {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Generate exactly 3 evidence-aware information-gain ideas for a content brief about "${body.topic || ''}" concerning "${body.destination || ''}" for "${body.audience || ''}". Do not present invented facts as verified. Return a JSON array of objects with need, contribution, and placeholder. Use placeholders such as [Verify with subject-matter expert] where evidence is absent.`,
        config: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 2200 },
      });
      const parsed = parseJson(response.text);
      return res.status(200).json({ suggestions: Array.isArray(parsed) ? parsed : parsed.suggestions || [] });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (error) {
    console.error('evidence-led-brief:', error);
    return res.status(500).json({ error: error?.message || 'AI request failed.' });
  }
}
