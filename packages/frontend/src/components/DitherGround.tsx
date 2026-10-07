import { onCleanup, onMount, type Component } from 'solid-js';
import { mountDither } from '../services/dither-ground.js';

/** API Bot's dithered ground, filling its positioned parent. */
const DitherGround: Component = () => {
  let canvas!: HTMLCanvasElement;
  onMount(() => onCleanup(mountDither(canvas)));
  return <canvas ref={canvas} class="dither-ground" aria-hidden="true" />;
};

export default DitherGround;
