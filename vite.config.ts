import { defineConfig, Plugin } from 'vite';
import fs from 'fs';
import path from 'path';

function copyLibavPlugin(): Plugin {
  return {
    name: 'copy-libav',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] || '';
        if (url.includes('/libav/')) {
          const fileName = url.substring(url.indexOf('/libav/') + '/libav/'.length);
          const filePath = path.join(process.cwd(), 'node_modules/libav.js/dist', fileName);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
              res.setHeader('Content-Type', 'text/javascript');
            } else if (filePath.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm');
            }
            return fs.createReadStream(filePath).pipe(res);
          }
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] || '';
        if (url.includes('/libav/')) {
          const fileName = url.substring(url.indexOf('/libav/') + '/libav/'.length);
          const filePath = path.join(process.cwd(), 'node_modules/libav.js/dist', fileName);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
              res.setHeader('Content-Type', 'text/javascript');
            } else if (filePath.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm');
            }
            return fs.createReadStream(filePath).pipe(res);
          }
        }
        next();
      });
    },
    closeBundle() {
      const srcDir = path.join(process.cwd(), 'node_modules/libav.js/dist');
      const destDir = path.join(process.cwd(), 'dist/libav');
      fs.mkdirSync(destDir, { recursive: true });
      fs.cpSync(srcDir, destDir, { recursive: true });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [copyLibavPlugin()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['libav.js'],
  },
});
