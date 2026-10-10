// Bundling settings used by `cf dev` / `cf build` (cf delegates JS Workers to Wrangler's bundler).
import { defineWranglerConfig } from 'wrangler/experimental-config';

export default defineWranglerConfig({
  assetsDirectory: '../web/dist',
});
