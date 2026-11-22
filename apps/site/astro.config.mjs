// @ts-check
import { defineConfig, envField } from 'astro/config';
import sitemap from '@astrojs/sitemap';
// `site` is needed at config time (canonical URLs, sitemap), before astro:env exists.
// Real env vars win; .env is optional (CI builds without one).
try { process.loadEnvFile(); } catch { /* no .env file */ }
const { PUBLIC_SITE_URL } = process.env;

export default defineConfig({
  site: PUBLIC_SITE_URL || 'http://localhost:4321',
  integrations: [sitemap()],
  env: {
    schema: {
      PUBLIC_SITE_URL: envField.string({ context: 'client', access: 'public', url: true, optional: true }),
      PUBLIC_LOBBY_URL: envField.string({ context: 'client', access: 'public', url: true, default: 'https://trylobby.app' }),
      // Publishable key: can only add people to the list, safe in the page.
      // Optional so CI can build without a .env; the page shows a notice instead of the form.
      PUBLIC_LOBBY_PROJECT_KEY: envField.string({ context: 'client', access: 'public', startsWith: 'pk_', optional: true }),
      // Admin API / CLI key. Server-only; never import it from client code.
      LOBBY_SECRET_KEY: envField.string({ context: 'server', access: 'secret', startsWith: 'sk_', optional: true }),
    },
  },
});
