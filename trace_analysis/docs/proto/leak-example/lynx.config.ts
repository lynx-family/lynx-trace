import { pluginHDT } from '@byted-lynx/hdt-rsbuild-plugin'
import { pluginReactLynx } from '@byted-lynx/react/rsbuild-plugin'
import { defineConfig } from '@byted-lynx/rspeedy'
import path from 'path';

// The Rspeedy Configuration. See https://rspeedy.byted.org/api/rspeedy for more options.
export default defineConfig({
  output: {
    // LynxGo 平台部署时的 assetPrefix, 在编译时注入环境变量
    assetPrefix: process.env.ASSET_PREFIX,
    sourceMap: {
      js: 'source-map',
    },
  },
  source: {
    entry: {
      main: './src/index.tsx',
    },
  },
  plugins: [
    pluginHDT({
      // The schema of the page to be opened.
      // Press `a` in the terminal to switch between schemas.
      schema(url) {
        return {
          http: url,
          aweme: `aweme://lynxview/?url=${url}`,
        }
      },
    }),
    // See https://rspeedy.byted.org/api/react-rsbuild-plugin.pluginreactlynx for more options.
    pluginReactLynx(),
  ],
})
