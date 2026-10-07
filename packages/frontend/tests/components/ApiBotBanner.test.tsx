import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';

const mockMountDither = vi.fn(() => () => {});
vi.mock('../../src/services/dither-ground.js', () => ({
  mountDither: (canvas: HTMLCanvasElement) => mockMountDither(canvas),
}));

import ApiBotBanner, { API_BOT_URL } from '../../src/components/ApiBotBanner';

describe('ApiBotBanner', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockMountDither.mockClear();
  });

  it('announces API Bot and links to its page in a new tab', () => {
    const { container } = render(() => <ApiBotBanner />);
    expect(screen.getByText('Introducing API Bot:')).toBeTruthy();
    expect(
      screen.getByText(/keep your app running through upstream API breaking changes/),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Get started' });
    expect(link.getAttribute('href')).toBe(API_BOT_URL);
    expect(API_BOT_URL).toBe('https://manifest.build/api-bot/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('canvas.dither-ground')).not.toBeNull();
    expect(mockMountDither).toHaveBeenCalledTimes(1);
  });

  it('hides for the session when closed', () => {
    const { container } = render(() => <ApiBotBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide this banner for this session' }));
    expect(container.querySelector('.api-bot-banner')).toBeNull();
    expect(sessionStorage.getItem('api-bot-banner-dismissed')).toBe('1');
  });

  it('stays hidden once dismissed in this session', () => {
    sessionStorage.setItem('api-bot-banner-dismissed', '1');
    const { container } = render(() => <ApiBotBanner />);
    expect(container.querySelector('.api-bot-banner')).toBeNull();
  });
});
