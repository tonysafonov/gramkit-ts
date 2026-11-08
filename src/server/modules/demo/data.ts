/** Mock data and in-memory state of the demo endpoints. Per process, reset on restart, as in Python. */

/** Counters by id (Python's `_counters`). */
export const counters = new Map<string, number>();

export interface MockItem {
  id: number;
  title: string;
  description: string;
}

export const MOCK_ITEMS: MockItem[] = Array.from({ length: 100 }, (_, index) => ({
  id: index + 1,
  title: `Item ${index + 1}`,
  description: `Description for item ${index + 1}`,
}));

export const MOCK_STREAM_TEXT = `
Streaming is the art of sending data incrementally,
character by character, to create a real-time experience.

This endpoint demonstrates:
- Server-Sent Events (SSE) protocol
- Non-blocking async generators
- Proper HTTP headers for streaming
- [DONE] sentinel to signal completion

The frontend parses \`data: \` prefixed lines from the response.
`.trim();

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  user: ['read_own_data', 'update_own_profile'],
  admin: ['read_own_data', 'update_own_profile', 'read_all_users', 'view_stats'],
  owner: ['read_own_data', 'update_own_profile', 'read_all_users', 'view_stats', 'protected_actions', 'manage_roles'],
};

export const ERROR_MESSAGES: Record<number, string> = {
  400: 'Bad request - invalid parameters provided',
  401: 'Unauthorized - authentication required',
  403: "Forbidden - you don't have permission",
  404: "Not found - resource doesn't exist",
  409: 'Conflict - resource already exists',
  422: 'Validation error - check your input',
  429: 'Rate limited - too many requests',
  500: 'Internal server error - something went wrong',
  502: 'Bad gateway - upstream server error',
  503: 'Service unavailable - try again later',
  504: 'Gateway timeout - upstream server timeout',
};

export const WEATHER_CONDITIONS = ['Sunny', 'Cloudy', 'Rainy', 'Snowy', 'Windy'];
export const NEWS_HEADLINES = [
  'Tech stocks surge on AI optimism',
  'New climate report released',
  'Central bank holds rates steady',
  'Startup raises record funding',
  'Market volatility expected',
];
export const NEWS_SOURCES = ['Reuters', 'Bloomberg', 'AP', 'BBC', 'TechCrunch'];
