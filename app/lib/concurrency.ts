/**
 * Concurrency control utilities for preventing resource exhaustion
 * under heavy load from multiple concurrent users
 */

// Track active deployments globally
let activeDeployments = 0;
const MAX_CONCURRENT_DEPLOYMENTS = 5; // Limit concurrent pipeline executions

// Simple semaphore for limiting concurrent operations
class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      next?.();
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }
}

// Global semaphore for deployments
const deploymentSemaphore = new Semaphore(MAX_CONCURRENT_DEPLOYMENTS);

/**
 * Wrapper for deployment operations that limits concurrency
 */
export async function withDeploymentLimit<T>(
  operation: () => Promise<T>
): Promise<T> {
  await deploymentSemaphore.acquire();
  activeDeployments++;

  try {
    return await operation();
  } finally {
    activeDeployments--;
    deploymentSemaphore.release();
  }
}

/**
 * Check if we can accept a new deployment
 */
export function canAcceptDeployment(): boolean {
  return deploymentSemaphore.available > 0;
}

/**
 * Get current deployment stats
 */
export function getDeploymentStats(): { active: number; max: number; available: number } {
  return {
    active: activeDeployments,
    max: MAX_CONCURRENT_DEPLOYMENTS,
    available: deploymentSemaphore.available
  };
}

// Simple in-memory rate limiter per IP
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 30; // 30 requests per minute per IP

/**
 * Check if request is rate limited
 */
export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

// Cleanup old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// Track for hot reload cleanup
if (process.env.NODE_ENV === 'development') {
  // @ts-ignore
  if (global.__concurrencyCleanup) {
    rateLimitMap.clear();
  }
  // @ts-ignore
  global.__concurrencyCleanup = true;
}
