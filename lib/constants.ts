// lib/constants.ts

export const STATUS_COLORS: Record<string, string> = {
  // Active states
  running: '#3b82f6', // Blue
  provisioning: '#f59e0b', // Amber/Orange
  
  // Terminal states
  completed: '#22c55e', // Green
  failed: '#ef4444', // Red
  terminated: '#374151', // Dark Gray
  
  // Passive states
  queued: '#6b7280', // Gray
  stopped: '#9ca3af', // Light Gray
  
  // Default fallback
  unknown: '#6b7280',
};

// You might also want to export common node types if you use them elsewhere
export const NODE_TYPES = {
  COMPUTE: 'compute',
  STORAGE: 'storage',
  GPU: 'gpu',
  NETWORK: 'network',
  SIMULATION: 'simulation',
} as const;