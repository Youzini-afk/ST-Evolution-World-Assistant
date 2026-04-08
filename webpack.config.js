// @ts-check
const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const { VueLoaderPlugin } = require("vue-loader");
const AutoImport = require("unplugin-auto-import/webpack");
const webpack = require("webpack");

/** @type {import('webpack').Configuration} */
const config = {
  entry: "./src/index.ts",

  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "index.js",
    clean: true,
    // ST 加载扩展 JS 时用 <script type="module">
    // IIFE 在 module 中照常执行
    iife: true,
  },

  resolve: {
    extensions: [".ts", ".tsx", ".js", ".vue", ".json"],
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },

  // jQuery, lodash, toastr 由 SillyTavern 主页面提供
  // 在 module scope 中必须用 globalThis 前缀才能访问到页面全局变量
  externals: {
    jquery: "globalThis jQuery",
  },

  module: {
    rules: [
      // Vue SFC
      {
        test: /\.vue$/,
        loader: "vue-loader",
      },
      // TypeScript
      {
        test: /\.tsx?$/,
        loader: "ts-loader",
        exclude: /node_modules/,
        options: {
          appendTsSuffixTo: [/\.vue$/],
          transpileOnly: true,
        },
      },
      // CSS (包括 Vue SFC <style> 和 node_modules CSS 如 @vue-flow)
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, "css-loader"],
      },
      // SCSS
      {
        test: /\.s[ac]ss$/,
        use: [MiniCssExtractPlugin.loader, "css-loader", "sass-loader"],
      },
    ],
  },

  plugins: [
    new VueLoaderPlugin(),

    new MiniCssExtractPlugin({
      filename: "style.css",
    }),

    AutoImport({
      imports: [
        "vue",
        "pinia",
        {
          klona: ["klona"],
          zod: [["z", "z"]],
          "@vueuse/core": ["useIntervalFn", "watchIgnorable"],
        },
      ],
      dts: path.resolve(__dirname, "src/auto-imports.d.ts"),
    }),

    // Vue feature flags
    new webpack.DefinePlugin({
      __VUE_OPTIONS_API__: JSON.stringify(true),
      __VUE_PROD_DEVTOOLS__: JSON.stringify(false),
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: JSON.stringify(false),
    }),
  ],

  optimization: {
    splitChunks: false,
    runtimeChunk: false,
  },
};

module.exports = config;
