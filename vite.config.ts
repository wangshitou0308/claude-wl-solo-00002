import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 纯前端离线构建：不使用任何外部 CDN，base 使用相对路径以便 file:// 直接打开
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: false },
});
