import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DITHER,
  GROUND_INK,
  GROUND_PAPER,
  GROUND_SHARE,
  density,
  mix,
  mountDither,
  smoothstep,
  threshold,
  windy,
} from '../../src/services/dither-ground';

function makeCtx() {
  return {
    createImageData: vi.fn((w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })),
    putImageData: vi.fn(),
  };
}

describe('dither ground helpers', () => {
  it('reads the Bayer threshold in (0, 1)', () => {
    expect(threshold(0, 0)).toBeCloseTo(0.5 / 64);
    expect(threshold(9, 8)).toBeCloseTo(32.5 / 64);
  });

  it('eases between two edges', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
  });

  it('keeps the top centre clean and fills the lower corners', () => {
    expect(density(0.5, 0)).toBe(0);
    expect(density(0, 1)).toBeCloseTo(DITHER.max);
  });

  it('matches the still ground at time 0 only near the base shape', () => {
    expect(windy(0.5, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(windy(0, 1, 3)).toBeGreaterThan(0);
  });

  it('mixes the green into the ground', () => {
    expect(mix(GROUND_INK, GROUND_PAPER, GROUND_SHARE)).toEqual([19, 79, 49]);
    expect(mix([255, 255, 255], [0, 0, 0], 0)).toEqual([0, 0, 0]);
  });
});

describe('mountDither', () => {
  let frames: FrameRequestCallback[];
  let ctx: ReturnType<typeof makeCtx> | null;
  let size = { w: 30, h: 12 };
  let reduced = false;
  let mediaListeners: Array<() => void>;
  let resizeCb: (() => void) | null;
  let viewCb: ((entries: Array<{ isIntersecting: boolean }>) => void) | null;
  const disconnects = { resize: vi.fn(), view: vi.fn() };
  const removeListener = vi.fn();

  function makeCanvas(withParent = true) {
    const canvas = document.createElement('canvas');
    if (withParent) {
      const parent = document.createElement('div');
      Object.defineProperty(parent, 'clientWidth', { get: () => size.w });
      Object.defineProperty(parent, 'clientHeight', { get: () => size.h });
      parent.appendChild(canvas);
    }
    return canvas;
  }

  beforeEach(() => {
    frames = [];
    ctx = makeCtx();
    size = { w: 30, h: 12 };
    reduced = false;
    mediaListeners = [];
    resizeCb = null;
    viewCb = null;
    let id = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as never);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return ++id;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_: string, fn: () => void) => mediaListeners.push(fn),
      removeEventListener: removeListener,
    }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resizeCb = cb;
        }
        observe() {}
        disconnect() {
          disconnects.resize();
        }
      },
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
          viewCb = cb;
        }
        observe() {}
        disconnect() {
          disconnects.view();
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns a no-op cleanup without a 2d context', () => {
    ctx = null;
    expect(() => mountDither(makeCanvas())()).not.toThrow();
  });

  it('returns a no-op cleanup without a parent', () => {
    expect(() => mountDither(makeCanvas(false))()).not.toThrow();
  });

  it('sizes the canvas to its parent and animates at the wind rate', () => {
    const canvas = makeCanvas();
    const cleanup = mountDither(canvas);
    expect(canvas.width).toBe(10);
    expect(canvas.height).toBe(4);
    expect(canvas.style.width).toBe('30px');
    expect(frames).toHaveLength(1);

    frames.shift()!(1000);
    expect(ctx!.putImageData).toHaveBeenCalledTimes(1);
    const data = (ctx!.putImageData.mock.calls[0]![0] as { data: Uint8ClampedArray }).data;
    expect(data.some((v) => v === 255)).toBe(true);

    // a frame within 1/20 s of the last one is skipped
    frames.shift()!(1010);
    expect(ctx!.putImageData).toHaveBeenCalledTimes(1);

    cleanup();
    expect(disconnects.resize).toHaveBeenCalled();
    expect(disconnects.view).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalled();
  });

  it('draws the still ground once when motion is reduced', () => {
    reduced = true;
    mountDither(makeCanvas());
    expect(frames).toHaveLength(0);
    expect(ctx!.putImageData).toHaveBeenCalledTimes(1);
  });

  it('stops the wind off screen and restarts it on screen', () => {
    mountDither(makeCanvas());
    viewCb!([{ isIntersecting: false }]);
    expect(ctx!.putImageData).toHaveBeenCalledTimes(1);
    frames.length = 0;
    viewCb!([{ isIntersecting: true }]);
    expect(frames).toHaveLength(1);
  });

  it('replays when the reduced-motion setting changes', () => {
    mountDither(makeCanvas());
    reduced = true;
    mediaListeners[0]!();
    expect(ctx!.putImageData).toHaveBeenCalledTimes(1);
  });

  it('skips drawing while the parent has no size, and measures again on resize', () => {
    size = { w: 0, h: 0 };
    mountDither(makeCanvas());
    expect(ctx!.createImageData).not.toHaveBeenCalled();
    size = { w: 3, h: 3 };
    resizeCb!();
    expect(ctx!.createImageData).toHaveBeenCalledWith(1, 1);
    frames.shift()!(1000);
    expect(ctx!.putImageData).toHaveBeenCalled();
  });

  it('draws a still ground when no frame has been measured yet', () => {
    size = { w: 0, h: 0 };
    reduced = true;
    mountDither(makeCanvas());
    viewCb!([{ isIntersecting: false }]);
    expect(ctx!.putImageData).not.toHaveBeenCalled();
  });

  it('works without matchMedia or observers', () => {
    vi.stubGlobal('matchMedia', undefined);
    vi.stubGlobal('ResizeObserver', undefined);
    vi.stubGlobal('IntersectionObserver', undefined);
    const cleanup = mountDither(makeCanvas());
    expect(frames).toHaveLength(1);
    expect(() => cleanup()).not.toThrow();
  });
});
