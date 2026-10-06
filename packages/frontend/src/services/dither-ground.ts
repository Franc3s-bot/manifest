/**
 * The dithered ground of the API Bot promotions, ported from the API Bot
 * website (scout-website/src/dither.js): the near-black ground, clean at the
 * top centre, then square pixels that grow denser toward the sides and the
 * floor, in the ordered dithering of the Bayer 8x8 matrix. Two colours only,
 * drawn on a canvas of one pixel per cell and stretched with
 * image-rendering: pixelated, so every pixel stays crisp.
 *
 * The ground is API Bot's own, so it is the same in both dashboard themes.
 * Two slow waves bend it like grass in a breeze while it is on screen; it
 * stays still for readers who ask for reduced motion.
 */

export const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

export const DITHER = {
  pixel: 3,
  reach: 0.55,
  fall: 1.12,
  max: 0.75,
  curve: 1.4,
  light: 0.5,
  floor: 1.05,
  lift: 0.78,
};

export const WIND = { across: 0.035, rise: 0.025, speed: 0.55, fps: 20 };

/** API Bot's ground (#0b0f0d) and its green (#22c574) laid over it at 35%. */
export const GROUND_PAPER: [number, number, number] = [11, 15, 13];
export const GROUND_INK: [number, number, number] = [34, 197, 116];
export const GROUND_SHARE = 0.35;

export function threshold(x: number, y: number): number {
  return (BAYER[y % 8]![x % 8]! + 0.5) / 64;
}

export function smoothstep(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

/** Density at u (0 to 1 across) and t (0 at the top, 1 at the floor). */
export function density(u: number, t: number): number {
  const across =
    (Math.abs(u - DITHER.light) / DITHER.light) * (DITHER.lift + (1 - DITHER.lift) * t);
  const d = Math.hypot(across, t * DITHER.floor);
  return DITHER.max * Math.pow(smoothstep(DITHER.reach, DITHER.fall, d), DITHER.curve);
}

/** The density bent by the wind; `time` is in seconds, 0 is the still ground. */
export function windy(u: number, t: number, time: number): number {
  const w = time * WIND.speed;
  const du =
    WIND.across * Math.sin(t * 9 + w * 2.1) + WIND.across * 0.5 * Math.sin(t * 17 - w * 1.3);
  const dt = WIND.rise * Math.sin(u * 7 - w * 1.7) * (0.4 + t);
  return density(u + du, t + dt);
}

export function mix(
  ink: [number, number, number],
  paper: [number, number, number],
  share: number,
): [number, number, number] {
  return ink.map((c, i) => Math.round(c * share + paper[i]! * (1 - share))) as [
    number,
    number,
    number,
  ];
}

/**
 * Draws the ground on `canvas`, sized to its parent, and keeps it in step with
 * resizes, visibility and the reduced-motion setting. Returns the cleanup.
 */
export function mountDither(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  const ground = canvas.parentElement;
  if (!ctx || !ground) return () => {};

  const still =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  const dot = mix(GROUND_INK, GROUND_PAPER, GROUND_SHARE);
  const P = DITHER.pixel;
  let cols = 0;
  let rows = 0;
  let image: ImageData | null = null;

  const measure = (): boolean => {
    cols = Math.ceil(ground.clientWidth / P);
    rows = Math.ceil(ground.clientHeight / P);
    if (!cols || !rows) return false;
    canvas.width = cols;
    canvas.height = rows;
    canvas.style.width = `${cols * P}px`;
    canvas.style.height = `${rows * P}px`;
    image = ctx.createImageData(cols, rows);
    return true;
  };

  const draw = (time: number) => {
    if (!image) return;
    const data = image.data;
    data.fill(0);
    for (let y = 0; y < rows; y++) {
      const t = rows > 1 ? y / (rows - 1) : 0;
      for (let x = 0; x < cols; x++) {
        const u = cols > 1 ? x / (cols - 1) : 0.5;
        if (windy(u, t, time) <= threshold(x, y)) continue;
        const i = (y * cols + x) * 4;
        data[i] = dot[0];
        data[i + 1] = dot[1];
        data[i + 2] = dot[2];
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  };

  // the wind blows only while the ground is on screen and motion is welcome
  let visible = true;
  let frame = 0;
  let last = 0;
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    if (now - last < 1000 / WIND.fps) return;
    last = now;
    draw(now / 1000);
  };
  const play = () => {
    cancelAnimationFrame(frame);
    if (visible && !still?.matches) frame = requestAnimationFrame(tick);
    else draw(0);
  };
  const refresh = () => {
    if (measure()) play();
  };

  refresh();
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
  resize?.observe(ground);
  const view =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          visible = entries[0]!.isIntersecting;
          play();
        })
      : null;
  view?.observe(ground);
  still?.addEventListener?.('change', play);

  return () => {
    cancelAnimationFrame(frame);
    resize?.disconnect();
    view?.disconnect();
    still?.removeEventListener?.('change', play);
  };
}
