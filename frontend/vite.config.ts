import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    // Permite importar el contrato compartido (../backend/src/lib/miniapp/contract.ts).
    fs: { allow: ['..'] },
  },
});
