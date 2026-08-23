import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // workspace TS 包直接编译（dev 无需 build）
  transpilePackages: ['@kbf/core'],
  // M1 起服务端代理 /api → Fastify:8899，避免 CORS
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://localhost:8899/api/:path*' }];
  },
};

export default nextConfig;
