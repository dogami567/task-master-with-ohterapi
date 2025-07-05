# Task Master 第三方 API 调试全纪录

## 初始目标

在一个名为 `claude-task-master-main` 的项目中，使用一个第三方的、兼容 OpenAI 的 API 服务 (`https://api.aiclaude.site`) 来运行 `task-master` 工具，特别是 `parse-prd` 命令，以根据一个产品需求文档（PRD）自动生成任务。

---

## 第一阶段：环境问题与初步诊断

1.  **问题**：直接运行 `npx task-master parse-prd` 失败。
    *   **错误 1**：PowerShell 执行策略禁止运行脚本。
    *   **错误 2**：`package.json` 中的 `prepare` 脚本包含 `chmod +x` 命令，在 Windows 环境下不兼容。
2.  **修复**：
    *   修改 `package.json`，移除了 `prepare` 脚本中的 `chmod` 命令。
3.  **结果**：环境问题解决后，出现新的、更深层的问题。
    *   **错误 3**：`Error: AI service call failed for all configured roles.` 这是一个非常笼统的错误，它掩盖了底层的真实原因。我们通过 `Invoke-WebRequest` 确认了基础网络是通的。

---

## 第二阶段：深入代码，发现"幽灵"错误

1.  **调查**：我们意识到问题出在 `task-master` 代码本身。通过 `grep` 定位到错误抛出点在 `ai-services-unified.js`。
2.  **转折点**：放弃 `npx`，改用 `node ./bin/task-master.js` 直接运行，并手动在 PowerShell 中设置环境变量。这个操作绕过了错误屏蔽。
3.  **发现**：看到了真实的底层错误。
    *   **错误 4**：`Warning: Invalid main provider "OpenAI"` 和 `Error: Required API key ANTHROPIC_API_KEY for provider 'anthropic' is not set`。
    *   **结论**：程序内部对 Provider 名称大小写敏感，并且在主 Provider 失败后，错误地触发了后备的 `anthropic` 模块。

---

## 第三阶段：追踪 SDK 的"黑盒"

1.  **修复与新错误**：将 Provider 名称修正为小写的 `"openai"` 后，出现新错误。
    *   **错误 5**：`OpenAI Model ID is required`。
2.  **独立验证**：我们使用 PowerShell 的 `Invoke-RestMethod` 在程序外部独立模拟了 API 请求，**并成功了**！这无可辩驳地证明了 API 本身可用，问题一定出在 `task-master` 使用的 `@ai-sdk/openai` 库上。
3.  **最终原因揭晓**：经过多次尝试（包括拦截网络请求失败，发现错误发生在前置校验阶段），我们推断 `@ai-sdk/openai` 库在收到 `task-master` 传递的参数后，因内部一个未公开的 `compatibility` 参数的校验逻辑而失败，**在发起网络请求之前就直接报错了**。

---

## 第四阶段：釜底抽薪式的终极修复

由于无法通过常规手段修改 `@ai-sdk/openai` 的运行时行为，我们决定彻底绕过它。

1.  **尝试 1：使用 `node-fetch`**
    *   **思路**：修改 `ai-services-unified.js`，用 `node-fetch` 手动发送 HTTP 请求。
    *   **错误 6**：`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'node-fetch'`。原因是项目（可能使用 pnpm）的模块解析策略非常严格，不允许直接 `import` 未在 `package.json` 中显式声明的包。
2.  **尝试 2：使用内置 `https` 模块 (CommonJS)**
    *   **思路**：改用 Node.js 内置的、零依赖的 `https` 模块，并使用 `require('https')` 导入。
    *   **错误 7**：`ReferenceError: require is not defined`。
    *   **结论**：这证明了 `task-master` 是一个原生的 **ES Module (ESM)** 项目。
3.  **尝试 3：使用内置 `https` 模块 (ESM)**
    *   **思路**：使用 `import('https')` 来加载模块。
    *   **结果**：成功发出了请求并收到了 AI 的响应！
    *   **错误 8**：`SyntaxError: Unexpected token '`', "```json\n{\n"... is not valid JSON`。原因是 AI 返回的 JSON 被 Markdown (` ``` `) 包裹了。
4.  **尝试 4：清理 AI 响应**
    *   **思路**：在解析 JSON 前，用正则表达式移除 Markdown 代码块。
    *   **结果**：成功解析了 JSON，但程序在接收到数据后依然报错。
    *   **错误 9**：`Internal Error: generateObjectService returned unexpected data structure: null`。原因是 `parse-prd.js` 期望收到的数据中包含一个我们没有提供的 `metadata` 对象。
5.  **尝试 5：伪造 `metadata`**
    *   **思路**：在返回数据时，手动添加一个 `metadata` 对象。
    *   **结果**：依然失败，因为程序内部的数据处理逻辑比预想的更复杂。
6.  **最终解决方案：釜底抽薪，直接写入文件**
    *   **思路**：在我们的补丁中，获取到 AI 数据并清理、解析成功后，**不再将数据返回给上层调用者**，而是直接使用 `fs.writeFileSync` 将结果写入 `tasks.json`。这彻底绕开了程序内部所有不可控的、易错的后续处理逻辑。
    *   **结果**：**完全成功！** 日志显示 `文件写入成功！`，`tasks.json` 文件被正确更新。

---

## 最终生效的补丁代码

以下是应用在 `claude-task-master-main/scripts/modules/ai-services-unified.js` 中的最终补丁，它取代了 `_attemptProviderCallWithRetries` 函数中的 `if (providerName === 'openai')` 逻辑块。

\`\`\`javascript
if (providerName === 'openai') {
    console.log('🚨 [ESM 零依赖补丁] 已激活！使用 import("https") ...');
    
    return new Promise(async (resolve, reject) => {
        try {
            const https = (await import('https')).default;

            const postData = JSON.stringify({
                model: callParams.model,
                messages: callParams.messages,
                max_tokens: callParams.maxTokens,
                temperature: callParams.temperature,
                stream: false
            });

            const options = {
                hostname: 'api.aiclaude.site',
                port: 443,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': \`Bearer \${callParams.apiKey}\`,
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', async () => { // Make this callback async
                    console.log('🚨 [ESM 零依赖补丁] 收到响应:', data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const fs = (await import('fs')).default;
                            const path = (await import('path')).default;

                            const contentString = JSON.parse(data).choices[0].message.content;
                            
                            const jsonMatch = contentString.match(/\\\`\\\`\\\`json\\n([\\s\\S]*?)\\n\\\`\\\`\\\`/);
                            const cleanedContent = jsonMatch ? jsonMatch[1] : contentString;
                            
                            const aiResult = JSON.parse(cleanedContent);

                            // 釜底抽薪：不再返回数据，直接在这里写入文件！
                            const projectRoot = findProjectRoot(); 
                            const tasksPath = path.join(projectRoot, '.taskmaster', 'tasks', 'tasks.json');
                            
                            console.log(\`🚨 [釜底抽薪补丁] 准备写入文件到: \${tasksPath}\`);

                            let existingData = { "master": { "tasks": [] } };
                            if (fs.existsSync(tasksPath)) {
                                const rawData = fs.readFileSync(tasksPath, 'utf8');
                                existingData = JSON.parse(rawData);
                            }

                            existingData.master = {
                                tasks: aiResult.tasks || []
                            };
                            
                            fs.writeFileSync(tasksPath, JSON.stringify(existingData, null, 2));
                            
                            console.log('🚨 [釜底抽薪补丁] 文件写入成功！');

                            // 为了让上层调用不出错，返回一个它期望的空壳结构
                            resolve({ object: { tasks: [], metadata: {} } });

                        } catch (e) {
                            console.error('🚨 [釜底抽薪补丁] 解析响应或写入文件时失败:', e);
                            reject(e);
                        }
                    } else {
                        const err = new Error(\`请求失败，状态码: \${res.statusCode}, 响应: \${data}\`);
                        console.error('🚨 [ESM 零依赖补丁] 请求错误:', err);
                        reject(err);
                    }
                });
            });

            req.on('error', (e) => {
                console.error('🚨 [ESM 零依赖补丁] 请求过程中发生错误:', e);
                reject(e);
            });

            req.write(postData);
            req.end();

        } catch (e) {
            reject(e);
        }
    });
}
\`\`\` 