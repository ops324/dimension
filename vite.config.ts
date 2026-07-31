import { defineConfig } from 'vite';

export default defineConfig({
  // 相対パス出力: Netlify/Vercel/GitHub Pages などサブパス配信でもそのまま動く
  base: './',
  build: {
    target: 'es2022',
  },
});
