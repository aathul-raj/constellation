/**
 * Singleton AI client for Gemini API
 * Prevents creating new client instances per request
 * Thread-safe for concurrent requests
 */

import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

// Singleton instance
let genAIInstance: GoogleGenerativeAI | null = null;
let modelCache: Map<string, GenerativeModel> = new Map();

/**
 * Get or create the singleton GoogleGenerativeAI instance
 */
export function getGenAI(): GoogleGenerativeAI {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  if (!genAIInstance) {
    genAIInstance = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  return genAIInstance;
}

/**
 * Get a cached model instance
 * Models are thread-safe and can be reused across requests
 */
export function getModel(modelName: string = "gemini-2.5-flash"): GenerativeModel {
  const genAI = getGenAI();

  if (!modelCache.has(modelName)) {
    modelCache.set(modelName, genAI.getGenerativeModel({ model: modelName }));
  }

  return modelCache.get(modelName)!;
}

/**
 * Generate content with timeout and abort support
 */
export async function generateWithTimeout(
  model: GenerativeModel,
  prompt: string,
  timeoutMs: number = 60000,
  signal?: AbortSignal
): Promise<string> {
  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`AI request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Clear timeout if aborted
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('AI request aborted'));
    });
  });

  // Race between generation and timeout
  const result = await Promise.race([
    model.generateContent(prompt),
    timeoutPromise
  ]);

  return result.response.text();
}

// Clear cache on hot reload in development
if (process.env.NODE_ENV === 'development') {
  // @ts-ignore - for hot reload cleanup
  if (global.__aiClientCleanup) {
    genAIInstance = null;
    modelCache.clear();
  }
  // @ts-ignore
  global.__aiClientCleanup = true;
}
