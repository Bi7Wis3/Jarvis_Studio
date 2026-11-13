import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.JARVIS_SERVER ?? 'http://127.0.0.1:4720';

export default defineConfig({
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        port: Number(process.env.WEB_PORT ?? 4719),
        strictPort: true,
        proxy: {
            '/api': server,
            '/mcp': server,
            '/ws': { target: server, ws: true },
        },
    },
});
