import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sharp est un module natif : on l'exclut du bundling pour qu'il soit
  // chargé directement depuis node_modules par les routes serveur.
  serverExternalPackages: ['sharp'],
};

export default nextConfig;
