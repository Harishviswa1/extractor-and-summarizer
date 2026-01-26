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

    async withRetry(operation) {
        const delays = [1000, 3000, 5000]; // Backoff: 1s, 3s, 5s

        for (let i = 0; i <= delays.length; i++) {
            try {
                return await operation();
            } catch (error) {
                // Check if error is retriable (429, 500, 502, 503)
                const status = error.status || (error.response ? error.response.status : null);
                const isRetriable = status === 429 || status === 500 || status === 502 || status === 503;

                if (!isRetriable || i === delays.length) {
                    throw error; // Not retriable or max retries reached
                }

                logger.warn(`OpenAI Error ${status}. Retrying in ${delays[i]}ms...`);
                await new Promise(resolve => setTimeout(resolve, delays[i]));
            }
        }
    }

    async summarize(text, options = {}) {
        return this.withRetry(async () => {
            const { lang = 'en', style = 'concise', length = 0 } = options;

            // ... Validation logic can be outside retry if deterministic, but okay here

            const prompt = this.buildSummarizePrompt(text, lang, style, length);

            const completion = await this.openai.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: this.model,
                max_tokens: 1500,
                temperature: 0.4,
            });

            const content = completion.choices[0].message.content;
            if (!content) throw new Error('OpenAI returned empty content');

            return content;
        });
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

        const prompt = `Compare the following two articles and return a strict JSON object with this structure:
        
        {
          "shared_points": ["Point 1", "Point 2"],
          "unique_to_a": ["Point unique to Article 1"],
          "unique_to_b": ["Point unique to Article 2"],
          "contradictions": [
            { "topic": "Topic Name", "article_a": "What Article 1 says", "article_b": "What Article 2 says" }
          ],
          "tone_comparison": { "article_a": "Tone description", "article_b": "Tone description" },
          "coverage_score": { "article_a": 0.0 to 1.0, "article_b": 0.0 to 1.0 },
          "recommendation": {
              "for_quick_update": "article_a" or "article_b",
              "for_in_depth_context": "article_a" or "article_b"
          }
        }

        Analysis Rules:
        1. "contradictions": List factual conflicts or opposing viewpoints.
        2. "coverage_score": Estimate how comprehensive each article is (0.0 = vague, 1.0 = highly detailed).
        
        Article 1: ${t1}...
        
        Article 2: ${t2}...`;

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
            // Dynamic Style Handling with Presets
            switch (style) {
                // Keep specific optimized prompts for known presets
                case 'bullet': instruction = 'Provide a bullet point summary.'; break;
                case 'eli5': instruction = 'Explain like I am 5 years old.'; break;
                case 'business': instruction = 'Focus on business impact, key metrics, and actionable insights.'; break;
                case 'headline': instruction = 'Provide a single sentence summary.'; break;
                // For everything else (or empty), use dynamic input or default to concise
                default: instruction = `Provide a ${style || 'concise'} summary.`;
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
            "seo_keywords": [ "keyword1", "keyword2", "keyword3", "..." ],
            "seo_meta_description": "SEO optimized description under 160 characters.",
            "headlines": {
                "seo": "Keyword rich title",
                "clickbait": "Curiosity inducing title",
                "emotional": "Title appealing to core emotions",
                "neutral": "Fact-based reporting title"
            },
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
