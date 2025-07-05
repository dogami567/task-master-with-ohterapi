import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';

console.log("--- 最小复现脚本启动 ---");

const openAIConfig = {
    baseURL: 'https://api.aiclaude.site/v1', // 修正：必须包含 /v1
    apiKey: process.env.OPENAI_API_KEY,      // 直接从环境变量读取
};

console.log("使用的配置:", {
    baseURL: openAIConfig.baseURL,
    apiKey: openAIConfig.apiKey ? '********' + openAIConfig.apiKey.slice(-4) : '未设置'
});

try {
    const openai = createOpenAI(openAIConfig);

    console.log("OpenAI 客户端创建成功，尝试生成对象...");

    const { object } = await generateObject({
        model: openai('gpt-3.5-turbo'), // 我们依然使用"欺骗"模型ID
        schema: z.object({
            city: z.string().describe('The city name.'),
        }),
        prompt: 'What is the capital of France?',
    });

    console.log("✅ 成功！API调用完成，返回对象:", object);

} catch (error) {
    console.error("❌ 失败！在最小脚本中捕获到错误:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
} 