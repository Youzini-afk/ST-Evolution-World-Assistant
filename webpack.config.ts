import path from 'path';
import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { VueLoaderPlugin } from 'vue-loader';
import AutoImport from 'unplugin-auto-import/webpack';

const config: webpack.Configuration = {
  entry: './src/index.ts',

  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    clean: true,
  },

  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.vue', '.json'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  // jQuery, lodash, toastr 由 SillyTavern 主页面提供
  externals: {
    jquery: 'jQuery',
  },

  module: {
    rules: [
      // Vue SFC
      {
        test: /\.vue$/,
        loader: 'vue-loader',
      },
      // TypeScript
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: {
          appendTsSuffixTo: [/\.vue$/],
          transpileOnly: true,
        },
      },
      // CSS (包括 Vue SFC <style> 和 node_modules CSS 如 @vue-flow)
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      // SCSS
      {
        test: /\.s[ac]ss$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader', 'sass-loader'],
      },
    ],
  },

  plugins: [
    new VueLoaderPlugin() as any,

    new MiniCssExtractPlugin({
      filename: 'style.css',
    }),

    // Vue 3 + Pinia + VueFlow 自动导入
    AutoImport({
      imports: ['vue', 'pinia'],
      dts: 'src/auto-imports.d.ts',
    }) as any,

    // Vue feature flags
    new webpack.DefinePlugin({
      __VUE_OPTIONS_API__: JSON.stringify(true),
      __VUE_PROD_DEVTOOLS__: JSON.stringify(false),
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: JSON.stringify(false),
    }),
  ],

  optimization: {
    minimize: true,
  },
};

export default config;
