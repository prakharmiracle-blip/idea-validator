// Serverless function — runs on Vercel, keeps your API key secret.
// The browser calls THIS, and this calls Claude. Your key never reaches the user.

const AGENT_PROMPTS = {
  market: (i) => [
    'You are a Market Research Agent. Estimate TAM, SAM, SOM, growth rate, and demand. Use web search. Output ONLY JSON: {"market_size":"","tam":"","sam":"","som":"","growth_rate":"","demand":"","confidence":0}',
    `IDEA: ${i.idea}\nAUDIENCE: ${i.audience}`,
  ],
  competitor: (i) => [
    'You are a Competitor Intelligence Agent. Find direct/indirect competitors, features, pricing, gaps. Use web search. Output ONLY JSON: {"competitors":[{"name":"","type":"","pricing":""}],"feature_gaps":[],"summary":""}',
    `IDEA: ${i.idea}`,
  ],
  painpoint: (i) => [
    'You are a Customer Pain Point Agent. Find complaints, feature requests, sentiment from forums/reviews. Use web search. Output ONLY JSON: {"pain_points":[],"feature_requests":[],"sentiment_score":""}',
    `PROBLEM: ${i.problem}\nIDEA: ${i.idea}`,
  ],
  trend: (i) => [
    'You are a Trend Analysis Agent. Identify industry trends, emerging tech, opportunities. Use web search. Output ONLY JSON: {"trends":[],"opportunities":[]}',
    `IDEA: ${i.idea}`,
  ],
  pricing: (i) => [
    'You are a Pricing Agent. Analyze competitor pricing, recommend a price, find revenue opportunities. Use web search. Output ONLY JSON: {"competitor_prices":[],"recommended_price":"","revenue_opportunities":[]}',
    `IDEA: ${i.idea}\nMODEL: ${i.pricing}`,
  ],
  risk: (i) => [
    'You are a Risk Analysis Agent. Identify technical, market, legal, competition risks. Output ONLY JSON: {"risks":[{"type":"","description":"","severity":""}],"severity":""}',
    `IDEA: ${i.idea}`,
  ],
};

const DECISION_PROMPT =
  'You are the Final Decision Agent. Given all research outputs, calculate scores 0-100 ' +
  '(market_score: size+growth+demand; competition_score: HIGHER=better entry/less saturated; ' +
  'risk_score: HIGHER=safer) and give recommendation BUILD (strong), MODIFY (mixed/pivot), or ' +
  'AVOID (weak/risky). Output ONLY JSON: {"recommendation":"BUILD|MODIFY|AVOID","confidence":0,' +
  '"market_score":0,"competition_score":0,"risk_score":0,"reasoning":""}';

// Builds an Anthropic content block for an uploaded PDF/image so it can be
// attached to the agent calls. Text-based uploads (txt/md/csv) don't need
// this — their content is inlined directly into the prompt text instead.
function buildFileBlock(file) {
  if (!file || !file.base64 || !file.mediaType) return null;
  if (file.mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.base64 } };
  }
  if (file.mediaType.startsWith('image/')) {
    return { type: 'image', source: { type: 'base64', media_type: file.mediaType, data: file.base64 } };
  }
  return null;
}

// Builds the text snippet appended to every agent's prompt so each one
// knows a supporting document was uploaded and how to use it.
function buildFileNote(file) {
  if (!file) return '';
  if (file.text) {
    return `\n\nThe user also uploaded a supporting document ("${file.name}"). Use its content below as additional context for your analysis, alongside the idea description:\n---\n${file.text}\n---`;
  }
  if (file.base64) {
    return `\n\nThe user also uploaded a supporting document ("${file.name}"), attached to this message as a file. Use it as additional context for your analysis, alongside the idea description.`;
  }
  return '';
}

async function callClaude(system, user, maxTokens, fileBlock) {
  const content = fileBlock ? [fileBlock, { type: 'text', text: user }] : user;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 1200,
      system: system + '\nRespond ONLY with valid JSON. No prose, no markdown fences.',
      messages: [{ role: 'user', content }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude API error');
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s >= 0 && e >= 0) clean = clean.slice(s, e + 1);
  return JSON.parse(clean);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  }

  try {
    const rawFile = req.body.file;
    const file =
      rawFile && (rawFile.base64 || rawFile.text)
        ? {
            name: String(rawFile.name || 'uploaded file').slice(0, 200),
            mediaType: rawFile.mediaType,
            base64: typeof rawFile.base64 === 'string' ? rawFile.base64 : undefined,
            // Cap inlined text so one upload can't blow up every prompt's token usage.
            text: typeof rawFile.text === 'string' ? rawFile.text.slice(0, 20000) : undefined,
          }
        : null;

    const input = {
      idea: (req.body.idea || '').trim(),
      problem: (req.body.problem || '').trim(),
      audience: (req.body.audience || '').trim(),
      pricing: (req.body.pricing || '').trim(),
      notes: (req.body.notes || '').trim(),
    };
    if (!input.idea && !file) {
      return res.status(400).json({ error: 'Please describe your idea, or upload a document.' });
    }
    if (!input.idea && file) {
      // No typed idea — tell every agent to read it out of the uploaded document instead.
      input.idea =
        '[No idea was typed by the user. Extract the startup idea, the problem it solves, the ' +
        'target audience, and the pricing model from the attached/uploaded document below, then ' +
        'base your entire analysis on that.]';
    }

    const fileBlock = buildFileBlock(file);
    const fileNote = buildFileNote(file);

    // Run the six research agents in parallel. Each one gets the same
    // uploaded document attached (if any) alongside its own prompt.
    const keys = ['market', 'competitor', 'painpoint', 'trend', 'pricing', 'risk'];
    const results = await Promise.all(
      keys.map(async (key) => {
        const [system, baseUser] = AGENT_PROMPTS[key](input);
        const user = baseUser + fileNote;
        try {
          return [key, await callClaude(system, user, 1200, fileBlock)];
        } catch (e) {
          return [key, {}];
        }
      })
    );
    const agents = Object.fromEntries(results);

    // Aggregate into a final decision.
    const decision = await callClaude(DECISION_PROMPT, JSON.stringify(agents), 1500);

    return res.status(200).json({ decision, agents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}