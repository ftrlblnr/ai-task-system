import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone-сборка для продакшен-Docker-образа (infra/docker) — минимальный
  // self-contained node_modules вместо полного дерева монорепозитория.
  output: 'standalone',
};

export default nextConfig;
