/**
 * Test Setup File
 *
 * Configures the test environment with:
 * - jest-dom matchers for DOM assertions
 * - Mock fetch infrastructure for API testing
 * - Provider wrappers for component rendering
 */

import '@testing-library/jest-dom';
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { type ReactElement } from 'react';

// ============================================================================
// Mock Fetch Infrastructure
// ============================================================================

/** Storage for registered mock API responses */
const mockResponses = new Map<string, { data: any; status: number }>();

/**
 * Register a mock API response for a given URL pattern.
 * When fetch is called with a matching URL, this data will be returned.
 *
 * @param url - The URL pattern to match (exact match)
 * @param data - The response data to return
 * @param status - HTTP status code (default: 200)
 */
export function mockApiResponse(url: string, data: any, status: number = 200): void {
  mockResponses.set(url, { data, status });
}

/**
 * Clear all registered mock responses.
 * Call this in afterEach to reset state between tests.
 */
export function clearMockResponses(): void {
  mockResponses.clear();
}

/**
 * The mock fetch function that intercepts API calls.
 * Routes requests to registered mock handlers, or returns 404 if no handler matches.
 */
const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();
  const method = init?.method?.toUpperCase() || 'GET';

  // Check for exact URL match first
  const exactMatch = mockResponses.get(url);
  if (exactMatch) {
    return new Response(JSON.stringify(exactMatch.data), ) {
      status: exactMatch.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check for pattern match (URL without query params)
  const baseUrl = url.split('?')[0];
  const baseMatch = mockResponses.get(baseUrl);
  if (baseMatch) {
    return new Response(JSON.stringify(baseMatch.data), ) {
      status: baseMatch.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Handle POST/PATCH/DELETE by echoing back the request body with an id
  if (method === 'POST' && init?.body) {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ id: 1, ...body }), ) {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (method === 'PATCH' && init?.body) {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ id: 1, ...body }), ) {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (method === 'DELETE') {
    return new Response(null, { status: 204 });
  }

  // No handler found
  return new Response(JSON.stringify({ error: 'Not Found' }), ) {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
});

// Install the mock fetch globally
vi.stubGlobal('fetch', mockFetch);

// ============================================================================
// Provider Wrappers
// ============================================================================

/**
 * Create a fresh QueryClient for testing.
 * Uses settings that prevent retries and background refetching during tests.
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Render a component wrapped in all necessary providers for testing.
 * Includes QueryClientProvider with a fresh client for each render.
 *
 * @param component - The React element to render
 * @param options - Additional render options from @testing-library/react
 * @returns The render result with all query methods
 */
export function renderWithProviders(
  component: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  const queryClient = createTestQueryClient();

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );

  return render(component, { wrapper: Wrapper, ...options });
}

// ============================================================================
// Test Lifecycle Hooks
// ============================================================================

/** Reset mock fetch and responses before each test */
beforeEach(() => {
  mockFetch.mockClear();
  clearMockResponses();
});
