import { defineConfig } from 'vite';

export default defineConfig({
  // 相対パス出力: Netlify/Vercel/GitHub Pages などサブパス配信でもそのまま動く
  base: './',
  // 並行セッション対応: ランチャーが PORT を割り当てたらそれに従う(未指定なら既定の 5173)。
  // Vite は PORT 環境変数を自分では読まないので、ここで明示的に橋渡しする。
  server: {
    port: Number(process.env.PORT) || 5173,
  },
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
