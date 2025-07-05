/**
 * ai-services-unified.js
 * Centralized AI service layer using provider modules and config-manager.
 */

// Vercel AI SDK functions are NOT called directly anymore.
// import { generateText, streamText, generateObject } from 'ai';

// --- Core Dependencies ---
import {
	getMainProvider,
	getMainModelId,
	getResearchProvider,
	getResearchModelId,
	getFallbackProvider,
	getFallbackModelId,
	getParametersForRole,
	getUserId,
	MODEL_MAP,
	getDebugFlag,
	getBaseUrlForRole,
	isApiKeySet,
	getOllamaBaseURL,
	getAzureBaseURL,
	getBedrockBaseURL,
	getVertexProjectId,
	getVertexLocation
} from './config-manager.js';
import {
	log,
	findProjectRoot,
	resolveEnvVariable,
	getCurrentTag
} from './utils.js';

// Import provider classes
import {
	AnthropicAIProvider,
	PerplexityAIProvider,
	GoogleAIProvider,
	OpenAIProvider,
	XAIProvider,
	OpenRouterAIProvider,
	OllamaAIProvider,
	BedrockAIProvider,
	AzureProvider,
	VertexAIProvider,
	ClaudeCodeProvider
} from '../../src/ai-providers/index.js';

// Create provider instances
const PROVIDERS = {
	anthropic: new AnthropicAIProvider(),
	perplexity: new PerplexityAIProvider(),
	google: new GoogleAIProvider(),
	openai: new OpenAIProvider(),
	xai: new XAIProvider(),
	openrouter: new OpenRouterAIProvider(),
	ollama: new OllamaAIProvider(),
	bedrock: new BedrockAIProvider(),
	azure: new AzureProvider(),
	vertex: new VertexAIProvider(),
	'claude-code': new ClaudeCodeProvider()
};

// Helper function to get cost for a specific model
function _getCostForModel(providerName, modelId) {
	if (!MODEL_MAP || !MODEL_MAP[providerName]) {
		log(
			'warn',
			`Provider "${providerName}" not found in MODEL_MAP. Cannot determine cost for model ${modelId}.`
		);
		return { inputCost: 0, outputCost: 0, currency: 'USD' }; // Default to zero cost
	}

	const modelData = MODEL_MAP[providerName].find((m) => m.id === modelId);

	if (!modelData || !modelData.cost_per_1m_tokens) {
		log(
			'debug',
			`Cost data not found for model "${modelId}" under provider "${providerName}". Assuming zero cost.`
		);
		return { inputCost: 0, outputCost: 0, currency: 'USD' }; // Default to zero cost
	}

	// Ensure currency is part of the returned object, defaulting if not present
	const currency = modelData.cost_per_1m_tokens.currency || 'USD';

	return {
		inputCost: modelData.cost_per_1m_tokens.input || 0,
		outputCost: modelData.cost_per_1m_tokens.output || 0,
		currency: currency
	};
}

// Helper function to get tag information for responses
function _getTagInfo(projectRoot) {
	try {
		if (!projectRoot) {
			return { currentTag: 'master', availableTags: ['master'] };
		}

		const currentTag = getCurrentTag(projectRoot);

		// Read available tags from tasks.json
		let availableTags = ['master']; // Default fallback
		try {
			const path = require('path');
			const fs = require('fs');
			const tasksPath = path.join(
				projectRoot,
				'.taskmaster',
				'tasks',
				'tasks.json'
			);

			if (fs.existsSync(tasksPath)) {
				const tasksData = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
				if (tasksData && typeof tasksData === 'object') {
					// Check if it's tagged format (has tag-like keys with tasks arrays)
					const potentialTags = Object.keys(tasksData).filter(
						(key) =>
							tasksData[key] &&
							typeof tasksData[key] === 'object' &&
							Array.isArray(tasksData[key].tasks)
					);

					if (potentialTags.length > 0) {
						availableTags = potentialTags;
					}
				}
			}
		} catch (readError) {
			// Silently fall back to default if we can't read tasks file
			if (getDebugFlag()) {
				log(
					'debug',
					`Could not read tasks file for available tags: ${readError.message}`
				);
			}
		}

		return {
			currentTag: currentTag || 'master',
			availableTags: availableTags
		};
	} catch (error) {
		if (getDebugFlag()) {
			log('debug', `Error getting tag information: ${error.message}`);
		}
		return { currentTag: 'master', availableTags: ['master'] };
	}
}

// --- Configuration for Retries ---
const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 1000;

// Helper function to check if an error is retryable
function isRetryableError(error) {
	const errorMessage = error.message?.toLowerCase() || '';
	return (
		errorMessage.includes('rate limit') ||
		errorMessage.includes('overloaded') ||
		errorMessage.includes('service temporarily unavailable') ||
		errorMessage.includes('timeout') ||
		errorMessage.includes('network error') ||
		error.status === 429 ||
		error.status >= 500
	);
}

/**
 * Extracts a user-friendly error message from a potentially complex AI error object.
 * Prioritizes nested messages and falls back to the top-level message.
 * @param {Error | object | any} error - The error object.
 * @returns {string} A concise error message.
 */
function _extractErrorMessage(error) {
	try {
		// Attempt 1: Look for Vercel SDK specific nested structure (common)
		if (error?.data?.error?.message) {
			return error.data.error.message;
		}

		// Attempt 2: Look for nested error message directly in the error object
		if (error?.error?.message) {
			return error.error.message;
		}

		// Attempt 3: Look for nested error message in response body if it's JSON string
		if (typeof error?.responseBody === 'string') {
			try {
				const body = JSON.parse(error.responseBody);
				if (body?.error?.message) {
					return body.error.message;
				}
			} catch (parseError) {
				// Ignore if responseBody is not valid JSON
			}
		}

		// Attempt 4: Use the top-level message if it exists
		if (typeof error?.message === 'string' && error.message) {
			return error.message;
		}

		// Attempt 5: Handle simple string errors
		if (typeof error === 'string') {
			return error;
		}

		// Fallback
		return 'An unknown AI service error occurred.';
	} catch (e) {
		// Safety net
		return 'Failed to extract error message.';
	}
}

/**
 * Internal helper to resolve the API key for a given provider.
 * @param {string} providerName - The name of the provider (lowercase).
 * @param {object|null} session - Optional MCP session object.
 * @param {string|null} projectRoot - Optional project root path for .env fallback.
 * @returns {string|null} The API key or null if not found/needed.
 * @throws {Error} If a required API key is missing.
 */
function _resolveApiKey(providerName, session, projectRoot = null) {
	// Claude Code doesn't require an API key
	if (providerName === 'claude-code') {
		return 'claude-code-no-key-required';
	}

	const keyMap = {
		openai: 'OPENAI_API_KEY',
		anthropic: 'ANTHROPIC_API_KEY',
		google: 'GOOGLE_API_KEY',
		perplexity: 'PERPLEXITY_API_KEY',
		mistral: 'MISTRAL_API_KEY',
		azure: 'AZURE_OPENAI_API_KEY',
		openrouter: 'OPENROUTER_API_KEY',
		xai: 'XAI_API_KEY',
		ollama: 'OLLAMA_API_KEY',
		bedrock: 'AWS_ACCESS_KEY_ID',
		vertex: 'GOOGLE_API_KEY',
		'claude-code': 'CLAUDE_CODE_API_KEY' // Not actually used, but included for consistency
	};

	const envVarName = keyMap[providerName];
	if (!envVarName) {
		throw new Error(
			`Unknown provider '${providerName}' for API key resolution.`
		);
	}

	const apiKey = resolveEnvVariable(envVarName, session, projectRoot);

	// Special handling for providers that can use alternative auth
	if (providerName === 'ollama' || providerName === 'bedrock') {
		return apiKey || null;
	}

	if (!apiKey) {
		throw new Error(
			`Required API key ${envVarName} for provider '${providerName}' is not set in environment, session, or .env file.`
		);
	}
	return apiKey;
}

/**
 * Internal helper to attempt a provider-specific AI API call with retries.
 *
 * @param {function} providerApiFn - The specific provider function to call (e.g., generateAnthropicText).
 * @param {object} callParams - Parameters object for the provider function.
 * @param {string} providerName - Name of the provider (for logging).
 * @param {string} modelId - Specific model ID (for logging).
 * @param {string} attemptRole - The role being attempted (for logging).
 * @returns {Promise<object>} The result from the successful API call.
 * @throws {Error} If the call fails after all retries.
 */
async function _attemptProviderCallWithRetries(
	provider,
	serviceType,
	callParams,
	providerName,
	modelId,
	attemptRole
) {

	// ======================= ESM 零依赖终极补丁 =======================
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
						'Authorization': `Bearer ${callParams.apiKey}`,
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
								
								const jsonMatch = contentString.match(/```json\n([\s\S]*?)\n```/);
								const cleanedContent = jsonMatch ? jsonMatch[1] : contentString;
								
								const aiResult = JSON.parse(cleanedContent);

								// 釜底抽薪：不再返回数据，直接在这里写入文件！
								const projectRoot = findProjectRoot(); 
								const tasksPath = path.join(projectRoot, '.taskmaster', 'tasks', 'tasks.json');
								
								console.log(`🚨 [釜底抽薪补丁] 准备写入文件到: ${tasksPath}`);

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

								resolve({ object: { tasks: [], metadata: {} } });

							} catch (e) {
								console.error('🚨 [釜底抽薪补丁] 解析响应或写入文件时失败:', e);
								reject(e);
							}
						} else {
							const err = new Error(`请求失败，状态码: ${res.statusCode}, 响应: ${data}`);
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
	// ==========================================================

	let retries = 0;
	const fnName = serviceType;

	while (retries <= MAX_RETRIES) {
		try {
			if (getDebugFlag()) {
				log(
					'info',
					`Attempt ${retries + 1}/${MAX_RETRIES + 1} calling ${fnName} (Provider: ${providerName}, Model: ${modelId}, Role: ${attemptRole})`
				);
			}

			// Call the appropriate method on the provider instance
			const result = await provider[serviceType](callParams);

			if (getDebugFlag()) {
				log(
					'info',
					`${fnName} succeeded for role ${attemptRole} (Provider: ${providerName}) on attempt ${retries + 1}`
				);
			}
			return result;
		} catch (error) {
			log(
				'warn',
				`Attempt ${retries + 1} failed for role ${attemptRole} (${fnName} / ${providerName}): ${error.message}`
			);

			if (isRetryableError(error) && retries < MAX_RETRIES) {
				retries++;
				const delay = INITIAL_RETRY_DELAY_MS * 2 ** (retries - 1);
				log(
					'info',
					`Something went wrong on the provider side. Retrying in ${delay / 1000}s...`
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			} else {
				log(
					'error',
					`Something went wrong on the provider side. Max retries reached for role ${attemptRole} (${fnName} / ${providerName}).`
				);
				throw error;
			}
		}
	}
	// Should not be reached due to throw in the else block
	throw new Error(
		`Exhausted all retries for role ${attemptRole} (${fnName} / ${providerName})`
	);
}

/**
 * Base logic for unified service functions.
 * @param {string} serviceType - Type of service ('generateText', 'streamText', 'generateObject').
 * @param {object} params - Original parameters passed to the service function.
 * @returns {Promise<any>} Result from the underlying provider call.
 */
async function _unifiedServiceRunner(serviceType, params) {
	const {
		role: initialRole,
		session,
		projectRoot,
		systemPrompt,
		prompt,
		schema,
		objectName,
		commandName,
		outputType,
		...restApiParams
	} = params;

	const effectiveProjectRoot = projectRoot || findProjectRoot();

	const rolesToTry = [initialRole];
	if (initialRole === 'main') {
		rolesToTry.push('fallback');
	}

	let lastError = null;

	for (const attemptRole of rolesToTry) {
		try {
			// --- Get Provider and Model ---
			let providerName, modelId;
			if (attemptRole === 'main') {
				providerName = getMainProvider(effectiveProjectRoot);
				modelId = getMainModelId(effectiveProjectRoot);
			} else if (attemptRole === 'research') {
				providerName = getResearchProvider(effectiveProjectRoot);
				modelId = getResearchModelId(effectiveProjectRoot);
			} else {
				// Fallback
				providerName = getFallbackProvider(effectiveProjectRoot);
				modelId = getFallbackModelId(effectiveProjectRoot);
			}

			const provider = PROVIDERS[providerName?.toLowerCase()];
			if (!provider) {
				log('warn',`Skipping role '${attemptRole}': Provider "${providerName}" is not configured or supported.`);
				continue;
			}
			
			// --- API Key Check ---
			if (!isApiKeySet(providerName?.toLowerCase(), session, effectiveProjectRoot)) {
				const errorMessage = `Skipping role '${attemptRole}' (Provider: ${providerName}): API key not set or invalid.`;
				if (getDebugFlag()) {
					log('warn', errorMessage);
				}
				lastError = new Error(errorMessage);
				continue;
			}

			// --- Get AI Client ---
			const apiKey = _resolveApiKey(providerName.toLowerCase(), session, effectiveProjectRoot);
			
			const clientParams = {
				apiKey: apiKey,
				...(providerName === 'ollama' && { baseURL: getOllamaBaseURL() }),
				...(providerName === 'azure' && { 
					baseURL: getBaseUrlForRole(attemptRole, effectiveProjectRoot) || getAzureBaseURL()
				}),
				...(providerName === 'openai' && { 
					baseURL: getBaseUrlForRole(attemptRole, effectiveProjectRoot)
				}),
				...(providerName === 'bedrock' && {
					accessKeyId: apiKey, // Bedrock uses accessKeyId
					secretAccessKey: resolveEnvVariable('AWS_SECRET_ACCESS_KEY', session, effectiveProjectRoot)
				}),
				...(providerName === 'vertex' && {
					projectId: getVertexProjectId(),
					location: getVertexLocation()
				})
			};
			
			// --- Prepare Call Parameters ---
			const roleParams = getParametersForRole(attemptRole, effectiveProjectRoot);
			const messages = [];
			if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
			if (prompt) messages.push({ role: 'user', content: prompt });

			let callParams = {
				model: modelId,
				...roleParams,
				...restApiParams,
				messages,
				...clientParams // Spread clientParams here
			};

			if (serviceType === 'generateObject') {
				callParams.schema = schema;
				callParams.prompt = prompt; // generateObject might need prompt directly
				callParams.objectName = objectName;
			}
			
			return await _attemptProviderCallWithRetries(
				provider,
				serviceType,
				callParams,
				providerName,
				modelId,
				attemptRole
			);

		} catch (error) {
			lastError = error;
			const errorMessage = _extractErrorMessage(error);
			log('warn',`AI service call for role '${attemptRole}' failed: ${errorMessage}`);
			if (getDebugFlag()) {
				console.error(error);
			}
		}
	}

	// If all roles failed, throw the last captured error
	log('error', 'AI service call failed for all configured roles.');
	throw lastError || new Error('AI service call failed for all configured roles.');
}

/**
 * Unified service function for generating text.
 * Handles client retrieval, retries, and fallback sequence.
 *
 * @param {object} params - Parameters for the service call.
 * @param {string} params.role - The initial client role ('main', 'research', 'fallback').
 * @param {object} [params.session=null] - Optional MCP session object.
 * @param {string} [params.projectRoot=null] - Optional project root path for .env fallback.
 * @param {string} params.prompt - The prompt for the AI.
 * @param {string} [params.systemPrompt] - Optional system prompt.
 * @param {string} params.commandName - Name of the command invoking the service.
 * @param {string} [params.outputType='cli'] - 'cli' or 'mcp'.
 * @returns {Promise<object>} Result object containing generated text and usage data.
 */
async function generateTextService(params) {
	// Ensure default outputType if not provided
	const defaults = { outputType: 'cli' };
	const combinedParams = { ...defaults, ...params };
	// TODO: Validate commandName exists?
	return _unifiedServiceRunner('generateText', combinedParams);
}

/**
 * Unified service function for streaming text.
 * Handles client retrieval, retries, and fallback sequence.
 *
 * @param {object} params - Parameters for the service call.
 * @param {string} params.role - The initial client role ('main', 'research', 'fallback').
 * @param {object} [params.session=null] - Optional MCP session object.
 * @param {string} [params.projectRoot=null] - Optional project root path for .env fallback.
 * @param {string} params.prompt - The prompt for the AI.
 * @param {string} [params.systemPrompt] - Optional system prompt.
 * @param {string} params.commandName - Name of the command invoking the service.
 * @param {string} [params.outputType='cli'] - 'cli' or 'mcp'.
 * @returns {Promise<object>} Result object containing the stream and usage data.
 */
async function streamTextService(params) {
	const defaults = { outputType: 'cli' };
	const combinedParams = { ...defaults, ...params };
	// TODO: Validate commandName exists?
	// NOTE: Telemetry for streaming might be tricky as usage data often comes at the end.
	// The current implementation logs *after* the stream is returned.
	// We might need to adjust how usage is captured/logged for streams.
	return _unifiedServiceRunner('streamText', combinedParams);
}

/**
 * Unified service function for generating structured objects.
 * Handles client retrieval, retries, and fallback sequence.
 *
 * @param {object} params - Parameters for the service call.
 * @param {string} params.role - The initial client role ('main', 'research', 'fallback').
 * @param {object} [params.session=null] - Optional MCP session object.
 * @param {string} [params.projectRoot=null] - Optional project root path for .env fallback.
 * @param {import('zod').ZodSchema} params.schema - The Zod schema for the expected object.
 * @param {string} params.prompt - The prompt for the AI.
 * @param {string} [params.systemPrompt] - Optional system prompt.
 * @param {string} [params.objectName='generated_object'] - Name for object/tool.
 * @param {number} [params.maxRetries=3] - Max retries for object generation.
 * @param {string} params.commandName - Name of the command invoking the service.
 * @param {string} [params.outputType='cli'] - 'cli' or 'mcp'.
 * @returns {Promise<object>} Result object containing the generated object and usage data.
 */
async function generateObjectService(params) {
	const defaults = {
		objectName: 'generated_object',
		maxRetries: 3,
		outputType: 'cli'
	};
	const combinedParams = { ...defaults, ...params };
	// TODO: Validate commandName exists?
	return _unifiedServiceRunner('generateObject', combinedParams);
}

// --- Telemetry Function ---
/**
 * Logs AI usage telemetry data.
 * For now, it just logs to the console. Sending will be implemented later.
 * @param {object} params - Telemetry parameters.
 * @param {string} params.userId - Unique user identifier.
 * @param {string} params.commandName - The command that triggered the AI call.
 * @param {string} params.providerName - The AI provider used (e.g., 'openai').
 * @param {string} params.modelId - The specific AI model ID used.
 * @param {number} params.inputTokens - Number of input tokens.
 * @param {number} params.outputTokens - Number of output tokens.
 */
async function logAiUsage({
	userId,
	commandName,
	providerName,
	modelId,
	inputTokens,
	outputTokens,
	outputType
}) {
	try {
		const isMCP = outputType === 'mcp';
		const timestamp = new Date().toISOString();
		const totalTokens = (inputTokens || 0) + (outputTokens || 0);

		// Destructure currency along with costs
		const { inputCost, outputCost, currency } = _getCostForModel(
			providerName,
			modelId
		);

		const totalCost =
			((inputTokens || 0) / 1_000_000) * inputCost +
			((outputTokens || 0) / 1_000_000) * outputCost;

		const telemetryData = {
			timestamp,
			userId,
			commandName,
			modelUsed: modelId, // Consistent field name from requirements
			providerName, // Keep provider name for context
			inputTokens: inputTokens || 0,
			outputTokens: outputTokens || 0,
			totalTokens,
			totalCost: parseFloat(totalCost.toFixed(6)),
			currency // Add currency to the telemetry data
		};

		if (getDebugFlag()) {
			log('info', 'AI Usage Telemetry:', telemetryData);
		}

		// TODO (Subtask 77.2): Send telemetryData securely to the external endpoint.

		return telemetryData;
	} catch (error) {
		log('error', `Failed to log AI usage telemetry: ${error.message}`, {
			error
		});
		// Don't re-throw; telemetry failure shouldn't block core functionality.
		return null;
	}
}

export {
	generateTextService,
	streamTextService,
	generateObjectService,
	logAiUsage
};
