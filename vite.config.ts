import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';

const managementBuildMarker = '<!-- CLIProxyAPI local management build -->';

function tryGitDescribe(args: string[]): string {
  try {
    return execSync(`git ${args.join(' ')}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// Get version from environment, git tag, or package.json
function getVersion(): string {
  // 1. Environment variable (set by GitHub Actions)
  if (process.env.VERSION) {
    return process.env.VERSION;
  }

  // 2. VERSION file
  try {
    const versionFile = fs.readFileSync(path.resolve(__dirname, 'VERSION'), 'utf8').trim();
    if (versionFile) {
      return versionFile;
    }
  } catch {
    // VERSION file not readable
  }

  // 3. Try git tag
  const gitTag =
    tryGitDescribe(['describe', '--tags', '--exact-match']) ||
    tryGitDescribe(['describe', '--tags']);
  if (gitTag) {
    return gitTag;
  }

  // 4. Fall back to package.json version
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
    if (pkg.version && pkg.version !== '0.0.0') {
      return pkg.version;
    }
  } catch {
    // package.json not readable
  }

  return 'dev';
}

function managementBuildMarkerPlugin() {
  return {
    name: 'management-build-marker',
    transformIndexHtml(html: string) {
      if (html.includes(managementBuildMarker)) {
        return html;
      }
      return `${managementBuildMarker}\n${html}`;
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    managementBuildMarkerPlugin(),
    viteSingleFile({
      removeViteModuleLoader: true,
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(getVersion()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    modules: {
      localsConvention: 'camelCase',
      generateScopedName: '[name]__[local]___[hash:base64:5]',
    },
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/styles/variables.scss" as *;`,
      },
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
