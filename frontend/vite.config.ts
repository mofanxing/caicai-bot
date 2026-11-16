import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const backendTarget = process.env.CAICAI_API_TARGET || 'http://127.0.0.1:8000';

// 开发代理让浏览器与后端同源，无需放开后端 CORS。
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (id.includes('/@ant-design/icons')) return 'icons';
          if (id.includes('/node_modules/react') || id.includes('/node_modules/scheduler')) return 'react-vendor';
          if (id.includes('/node_modules/antd/')) return 'antd-components';
          return 'ui-vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backendTarget, changeOrigin: true },
      '/health': { target: backendTarget, changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      '/api': { target: backendTarget, changeOrigin: true },
      '/health': { target: backendTarget, changeOrigin: true },
    },
  },
  test: { environment: 'jsdom', restoreMocks: true },
});
