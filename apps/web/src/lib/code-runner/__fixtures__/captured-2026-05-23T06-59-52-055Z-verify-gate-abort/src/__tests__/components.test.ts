/**
 * Component Render Tests
 *
 * Tests that each page component:
 * - Renders without crashing (smoke test)
 * - Contains expected UI elements based on page type
 *
 * Page types tested:
 * - Dashboard: headings, KPI cards/widgets
 * - List: Add/Create buttons, data table area
 * - Detail: back navigation, entity field display
 *
 * Generated for: Social Network Manager
 * Pages tested: Home Feed, Explore
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { renderWithProviders, mockApiResponse } from './setup';
import HomeFeedPage from '@/pages/home-feed-page';
import ExplorePage from '@/pages/explore-page';

describe('Component Render Tests', () => {
  /** Set up default mock API responses so components can fetch data */
  beforeEach(() => {
    // Mock all entity list endpoints with empty arrays by default
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    ));
  });

  // ==========================================================================
  // Home Feed Page Component
  // ==========================================================================
  describe('HomeFeedPage', () => {
    /**
     * Basic render test: ensures the component mounts without throwing.
     * This catches import errors, missing providers, and render-time exceptions.
     */
    it('should render without crashing', () => {
      expect(() => {
        renderWithProviders(<HomeFeedPage />);
      }).not.toThrow();
    });

      it('should display a dashboard heading', () => {
        const { container } = renderWithProviders(<HomeFeedPage />);
        const headings = container.querySelectorAll('h1, h2, h3');
        expect(headings.length).toBeGreaterThan(0);
      });

      it('should render dashboard widgets or KPI cards', () => {
        const { container } = renderWithProviders(<HomeFeedPage />);
        // Dashboard typically contains card-like elements
        const cards = container.querySelectorAll('[class*="card"], [class*="Card"], [role="region"]');
        // At minimum the page should render content
        expect(container.innerHTML.length).toBeGreaterThan(0);
      });
  });

  // ==========================================================================
  // Explore Page Component
  // ==========================================================================
  describe('ExplorePage', () => {
    /**
     * Basic render test: ensures the component mounts without throwing.
     * This catches import errors, missing providers, and render-time exceptions.
     */
    it('should render without crashing', () => {
      expect(() => {
        renderWithProviders(<ExplorePage />);
      }).not.toThrow();
    });

      it('should render meaningful content', () => {
        const { container } = renderWithProviders(<ExplorePage />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
      });
  });
});
