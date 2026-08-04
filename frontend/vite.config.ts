import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The proxy is the only thing that makes every URL in the app work: the client
 * uses same-origin relative paths throughout, so `dev` is the supported mode.
 * See src/wire/urls.ts for the env override that makes a hosted build possible.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    // A silent fallback to 3001 leaves the user on a dead tab: `make stop`
    // kills :3000 and start.sh prints :3000.
    strictPort: true,
    proxy: {
      // Order matters. Vite matches prefixes in insertion order and only this
      // entry carries `ws: true`, so it has to precede the bare `/api`.
      '/api/ws': { target: 'http://localhost:8000', changeOrigin: true, ws: true },
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/camera': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/camera/, ''),
        // /mjpeg is multipart/x-mixed-replace — an infinite response. Any
        // timeout at all would sever the feed mid-stream.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
})
