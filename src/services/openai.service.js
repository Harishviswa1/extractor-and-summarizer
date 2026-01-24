const OpenAI = require('openai');
const logger = require('../config/logger');
const AppError = require('../utils/appError');

class OpenAIService {
    constructor() {
        // Debugging: Support both standard and custom env var names
        let key = process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY;

        if (!key) {
            logger.error('CRITICAL: OPEN_AI_KEY is missing from process.env');
            // Use empty string to prevent constructor crash, requests will fail gracefully later
            key = '';
        } else {
            key = String(key).trim();
            // Safe logging
            const preview = key.length >= 6 ? `${key.substring(0, 3)}...${key.substring(key.length - 3)}` : '***';
            logger.info(`OpenAI Key loaded: ${preview}`);
        }

        this.openai = new OpenAI({
            apiKey: key,
        });

        this.model = 'gpt-4o-mini';
    }

    async summarize(text, options = {}) {
        const { lang = 'en', style = 'concise', length = 0 } = options;

        // Validation
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            throw new AppError('No text provided for summarization', 400);
        }

        const prompt = this.buildSummarizePrompt(text, lang, style, length);

        try {
            const completion = await this.openai.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: this.model,
                max_tokens: 1500, // Increased for longer summaries
                temperature: 0.4, // Slightly clearer output
            });

            const content = completion.choices[0].message.content;
            if (!content) throw new Error('OpenAI returned empty content');

            return content;
        } catch (error) {
            logger.error('OpenAI Error:', error);
            if (error.status === 401) throw new AppError('Invalid OpenAI API Key', 500);
            if (error.status === 429) throw new AppError('OpenAI Rate Limit Exceeded', 429);
            if (error.status === 400) throw new AppError(`OpenAI Bad Request: ${error.message}`, 400);

            throw new AppError(`AI Service functionality failed: ${error.message}`, 502);
        }
    }

    // ... (keep generateHeadlines & compare methods same as before if needed, or update similarly) 

    async generateHeadlines(text) {
        // Guard against empty text
        const safeText = (text || '').substring(0, 3000);
        const prompt = `Based on the following text, generate 4 types of headlines:
        1. SEO Optimized
        2. Clickbait
        3. Emotional
        4. Neutral
        
        Format output as JSON: { "seo": "...", "clickbait": "...", "emotional": "...", "neutral": "..." }
        
        Text: ${safeText}`;

        try {
            const completion = await this.openai.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: this.model,
                response_format: { type: "json_object" },
                max_tokens: 300,
            });

            return JSON.parse(completion.choices[0].message.content);
        } catch (error) {
            logger.error('OpenAI Headline Error:', error);
            throw new AppError('AI Service error', 503);
        }
    }

    async compare(text1, text2) {
        const t1 = (text1 || '').substring(0, 3000);
        const t2 = (text2 || '').substring(0, 3000);

        const prompt = `Compare the following two articles. Identify biased language, contradictions, and tone differences.
        
        Finally, determine **which article is better** based on objective reporting, depth, and clarity.
        
        Article 1: ${t1}...
        
        Article 2: ${t2}...
        
        Output JSON: { 
            "bias_analysis": "...", 
            "contradictions": ["..."], 
            "tone_comparison": "...",
            "best_article": "Article 1" or "Article 2",
            "reasoning": "Why it is better..."
        }`;

        try {
            const completion = await this.openai.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: this.model,
                response_format: { type: "json_object" },
                max_tokens: 1000,
            });
            return JSON.parse(completion.choices[0].message.content);
        } catch (error) {
            throw new AppError('Comparison failed', 503);
        }
    }

    buildSummarizePrompt(text, lang, style, length) {
        let instruction = '';

        // Priority: Length > Style
        if (length > 0) {
            instruction = `Provide a summary exactly ${length} paragraphs long.`;
        } else {
            switch (style) {
                case 'bullet': instruction = 'Provide a bullet point summary.'; break;
                case 'eli5': instruction = 'Explain like I am 5 years old.'; break;
                case 'business': instruction = 'Focus on business impact, key metrics, and actionable insights.'; break;
                case 'headline': instruction = 'Provide a single sentence summary.'; break;
                default: instruction = 'Provide a concise summary.';
            }
        }

        // Guard against undefined text
        const safeText = (text || '').substring(0, 15000); // 15k chars context

        // Optimized Prompt: Removes generic "Translate to" message which causes artifacts
        return `
        Task: Summarize the content below in ${lang} language.
        Style: ${instruction}
        Constraints: 
        - Ignore navigation menus, footers, "Read More" links, and promotional text.
        - Do NOT include phrases like "Translation to English" or "Summary:". Just return the content.
        - Do NOT use Markdown formatting or HTML tags. Return plain text.
        
        Content:
        ${safeText} 
        `;
    }
    async analyze(text) {
        if (!text) throw new AppError('Text is required for analysis', 400);

        // "Standard Analysis Data" Prompt
        const prompt = `Perform a comprehensive analysis of the text below. return valid strict JSON.
        
        Output Structure:
        {
            "sentiment": { "score": 0.0 to 1.0, "label": "Positive/Negative/Neutral" },
            "bias_check": { "is_biased": boolean, "bias_type": "political/commercial/none", "description": "short explanation" },
            "key_entities": [ { "name": "...", "type": "Person/Org/Loc" } ],
            "readability": { "flesch_kincaid_grade": number, "level": "Easy/Medium/Hard" },
            "category": "Technology/Politics/Health/...",
            "summary_sentence": "One sentence overview."
        }

        Text: ${text.substring(0, 10000)}`;

        try {
            const completion = await this.openai.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: this.model,
                response_format: { type: "json_object" },
                max_tokens: 800,
                temperature: 0.3,
            });
            return JSON.parse(completion.choices[0].message.content);
        } catch (error) {
            logger.error('Analyze Error:', error);
            throw new AppError('Analysis failed', 503);
        }
    }

    async rewrite(text, options = {}) {
        if (!text) throw new AppError('Text is required for rewriting', 400);

        // Dynamic Parameters with Defaults
        const {
            format = 'general',
            tone = 'modern',
            audience = 'general',
            length = 'medium',
            lang = 'en'  // New: Language Support
        } = options;

        // Latency Optimization: Truncate input to avoid massive context (approx 15k chars is ~3k tokens)
        // This significantly reduces processing time for long articles.
        const safeText = text.substring(0, 15000);

        const systemInstruction = `You are an expert editor and content strategist. 
        Your task is to rewrite the provided content into a specific format, tone, and language.`;

        const userPrompt = `
        Content to Rewrite:
        "${safeText}..."

        Target Configuration:
        - Format/Style: ${format} (e.g. LinkedIn, Tweet, Blog, Email, etc.)
        - Tone: ${tone}
        - Audience: ${audience}
        - Length: ${length}
        - Language: ${lang}

        Instructions:
        1. Adaptation: Completely adapt the structure and vocabulary to fit the '${format}' format.
        2. Language: Output STRICTLY in ${lang}.
        3. Formatting: Use appropriate formatting (bullet points, emojis for social, paragraphs for blogs).
        4. Constraints: Do NOT use Markdown formatting (like **bold**, # Header) unless specifically requested by format "markdown". Do NOT use HTML tags. Return plain text content inside JSON.
        5. Viral Elements: If format implies social media, include a hook and 3-5 relevant hashtags.
        
        Output:
        Return valid JSON with a single key "rewritten_text" containing the result.
        `;

        try {
            const completion = await this.openai.chat.completions.create({
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: userPrompt }
                ],
                model: this.model,
                response_format: { type: "json_object" },
                max_tokens: 2000,
                temperature: 0.7,
            });

            const content = completion.choices[0].message.content;
            if (!content) throw new Error('Empty response from AI');

            return JSON.parse(content);
        } catch (error) {
            logger.error('Rewrite Error:', error);
            throw new AppError('Rewrite failed', 503);
        }
    }
}

module.exports = new OpenAIService();
