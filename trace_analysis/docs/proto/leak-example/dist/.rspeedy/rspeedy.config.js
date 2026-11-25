export default {
  output: {
    filename: {
      bundle: '[name]/template.js',
      template: '[name]/template.js'
    },
    inlineScripts: true,
    assetPrefix: 'https://6a71a3a811d356002294e4ec.go-preview.bytedance.net/'
  },
  tools: {
    rsdoctor: {
      experiments: {
        enableNativePlugin: true
      }
    }
  },
  source: {
    entry: {
      main: './src/index.tsx'
    }
  },
  plugins: [
    {
      name: 'lynx:rsbuild:HDT',
      pre: [
        'lynx:rsbuild:api'
      ],
      remove: [
        'lynx:rsbuild:qrcode'
      ],
      setup: function () { /* omitted long function */ }
    },
    {
      name: 'lynx:react',
      pre: [
        'lynx:rsbuild:api'
      ],
      setup: function () { /* omitted long function */ }
    }
  ]
}