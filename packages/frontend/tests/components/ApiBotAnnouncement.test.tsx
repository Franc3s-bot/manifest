import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@solidjs/testing-library';

const cleanup = vi.fn();
vi.mock('../../src/services/dither-ground.js', () => ({
  mountDither: () => cleanup,
}));

import ApiBotAnnouncement from '../../src/components/ApiBotAnnouncement';

describe('ApiBotAnnouncement', () => {
  beforeEach(() => {
    sessionStorage.clear();
    cleanup.mockClear();
  });

  it('shows the image, title, text and a link to API Bot', () => {
    const { container } = render(() => <ApiBotAnnouncement />);
    const image = screen.getByAltText('API Bot works with any API');
    expect(image.getAttribute('src')).toBe('/api-bot-works-with-any-api.svg');
    expect(screen.getByText('Meet API Bot')).toBeTruthy();
    expect(screen.getByText("API changes won't take your app down anymore.")).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Get started' });
    expect(link.getAttribute('href')).toBe('https://manifest.build/api-bot/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('canvas.dither-ground')).not.toBeNull();
  });

  it('hides for the session when closed and stops the ground', () => {
    const { container } = render(() => <ApiBotAnnouncement />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the announcement for this session' }));
    expect(container.querySelector('.sidebar-api-bot')).toBeNull();
    expect(sessionStorage.getItem('api-bot-card-dismissed')).toBe('1');
    expect(cleanup).toHaveBeenCalled();
  });

  it('stays hidden once dismissed in this session', () => {
    sessionStorage.setItem('api-bot-card-dismissed', '1');
    const { container } = render(() => <ApiBotAnnouncement />);
    expect(container.querySelector('.sidebar-api-bot')).toBeNull();
  });
});
