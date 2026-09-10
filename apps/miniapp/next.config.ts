import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone-сборка — как apps/web, на случай будущего Docker-деплоя
  // (Dockerfile для miniapp пока не заведён, это следующий шаг).
  output: 'standalone',
};

export default nextConfig;
