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
        
        Content:
        ${safeText} 
        `;
    }
}

module.exports = new OpenAIService();
