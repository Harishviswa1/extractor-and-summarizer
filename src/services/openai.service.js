const OpenAI = require('openai');
const logger = require('../config/logger');
const AppError = require('../utils/appError');

class OpenAIService {
    constructor() {
        // Debugging: Support both standard and custom env var names
        const key = process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY;
        if (!key) {
            logger.error('CRITICAL: OPEN_AI_KEY is missing from process.env');
        } else {
            logger.info(`OpenAI Key loaded: ${key.substring(0, 5)}...`);
        }

        this.openai = new OpenAI({
            apiKey: key,
        });

        this.model = 'gpt-4o-mini';
    }

    async summarize(text, lang = 'en', style = 'bullet') {
        const prompt = this.buildSummarizePrompt(text, lang, style);

        try {
            const completion = await this.openai.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: this.model,
                max_tokens: 1000, // Cost guardrail
                temperature: 0.5,
            });

            return completion.choices[0].message.content;
        } catch (error) {
            logger.error('OpenAI Error:', error);
            throw new AppError('AI Service currently unavailable', 503);
        }
    }

    async generateHeadlines(text) {
        const prompt = `Based on the following text, generate 4 types of headlines:
        1. SEO Optimized
        2. Clickbait
        3. Emotional
        4. Neutral
        
        Format output as JSON: { "seo": "...", "clickbait": "...", "emotional": "...", "neutral": "..." }
        
        Text: ${text.substring(0, 3000)}`; // Truncate to save tokens

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
        const prompt = `Compare the following two articles. Identify biased language, contradictions, and tone differences.
        
        Article 1: ${text1.substring(0, 2000)}...
        
        Article 2: ${text2.substring(0, 2000)}...
        
        Output JSON: { "bias_analysis": "...", "contradictions": ["..."], "tone_comparison": "..." }`;

        try {
            // ... Call OpenAI similar to above
            // Placeholder for brevity in this initial code dump, implementing logic:
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

    buildSummarizePrompt(text, lang, style) {
        let styleInstruction = '';
        switch (style) {
            case 'bullet': styleInstruction = 'Provide a bullet point summary.'; break;
            case 'eli5': styleInstruction = 'Explain like I am 5 years old.'; break;
            case 'business': styleInstruction = 'Focus on business impact, key metrics, and actionable insights.'; break;
            case 'headline': styleInstruction = 'Provide a single sentence summary.'; break;
            default: styleInstruction = 'Provide a concise summary.';
        }

        return `Analyze the following text and translate the result to ${lang}. ${styleInstruction}
        
        Text:
        ${text.substring(0, 10000)} 
        `; // Guardrail: Max 10k chars input sent to LLM
    }
}

module.exports = new OpenAIService();
