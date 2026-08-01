import { defineConfig } from 'vite';

export default defineConfig({
  // 相対パス出力: Netlify/Vercel/GitHub Pages などサブパス配信でもそのまま動く
  base: './',
  build: {
    target: 'es2022',
    /**
     * three(523KB / gzip 131KB)は exact pin のベンダーチャンクで、アプリ側の
     * 更新では中身が変わらない。分離したうえで閾値をその上へ置く ──
     * 「分割できるのに単一チャンクになっている」という警告本来の意味は解消済み。
     */
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // three をアプリコードから切り離す(独立キャッシュ + 警告の解消)
        manualChunks: { three: ['three'] },
      },
    },
  },
});
