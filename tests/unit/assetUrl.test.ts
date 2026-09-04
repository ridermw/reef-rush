import { expect, it } from 'vitest';
import { assetUrl } from '../../src/config/assetUrl';

it('prefixes public assets with the Vite base path', () => {
  expect(assetUrl('/assets/fish.glb')).toBe('/reef-rush/assets/fish.glb');
});
