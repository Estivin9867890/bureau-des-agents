import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En développement, Vite sert le bureau (port 5174) et passe la connexion /ws au pont (port 4848).
// `vite build --mode artifact` (npm run build:artifact) fabrique le bureau autonome de la page claude.ai :
// dist-artifact/, chemins relatifs, sans serveur (le pont navigateur remplace le serveur ; voir src/net/artifact-bridge.ts).
export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact';
  return {
    plugins: [react()],
    base: artifact ? './' : '/',
    server: {
      port: 5174,
      strictPort: true,
      proxy: { '/ws': { target: 'ws://127.0.0.1:4848', ws: true }, '/apercu': { target: 'http://127.0.0.1:4848' } },
    },
    build: { outDir: artifact ? 'dist-artifact' : 'dist', chunkSizeWarningLimit: 1500 },
  };
});
