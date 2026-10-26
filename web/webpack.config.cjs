const path = require('path')
const fs = require('fs')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const dotenv = require('dotenv')
const repositoryRoot = path.resolve(__dirname, '..')
const perBuildKeys = ['APP_VERSION', 'BUILD_TIME', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_TIMESTAMP', 'VERCEL_GIT_COMMIT_REF']

// Keep these exclusions paired with the disabled external wallets in main.tsx.
const unusedWalletPackages = [
  '@coinbase/wallet-sdk',
  '@walletconnect/ethereum-provider',
  '@walletconnect/universal-provider',
  '@solana/kit',
  '@solana-program/system',
  '@solana-program/token',
  '@solana-program/token-2022',
  '@solana-program/memo',
  '@solana-program/compute-budget',
]

const originOf = (value) => {
  try { return new URL(value).origin } catch { return '' }
}

const envKeys = [
  'PRIVY_APP_ID',
  'PRIVY_CLIENT_ID',
  'API_BASE_URL',
  'APP_VERSION',
  'BUILD_TIME',
  'DEV_TLS_CERT',
  'DEV_TLS_KEY',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_TIMESTAMP',
  'VERCEL_GIT_COMMIT_REF',
]

const parseEnvFile = (filename, { required = false, external = false } = {}) => {
  const envPath = external ? filename : path.resolve(__dirname, filename)
  if (!fs.existsSync(envPath)) {
    if (required) throw new Error(`Configured AIFIT_WEB_ENV_FILE does not exist: ${envPath}`)
    return {}
  }
  return dotenv.parse(fs.readFileSync(envPath))
}

const loadEnv = () => {
  const externalEnvFile = (process.env.AIFIT_WEB_ENV_FILE || '').trim()
  if (externalEnvFile) {
    if (!path.isAbsolute(externalEnvFile)) {
      throw new Error('AIFIT_WEB_ENV_FILE must be an absolute path outside the repository')
    }
    const relativeToRepository = path.relative(repositoryRoot, path.resolve(externalEnvFile))
    if (!relativeToRepository
      || (!relativeToRepository.startsWith('..') && !path.isAbsolute(relativeToRepository))) {
      throw new Error('AIFIT_WEB_ENV_FILE must point outside the repository')
    }
  }
  const parsed = {
    ...parseEnvFile('.env'),
    ...parseEnvFile('.env.local'),
    ...(externalEnvFile
      ? parseEnvFile(externalEnvFile, { required: true, external: true })
      : {}),
    ...process.env,
  }
  return envKeys.reduce((acc, key) => {
    const value = parsed[key] ?? ''
    acc[key] = value
    return acc
  }, {})
}

module.exports = (_env, argv) => {
  const mode = argv.mode || 'development'
  const env = { ...loadEnv(), NODE_ENV: mode }
  if (!env.BUILD_TIME) {
    env.BUILD_TIME = new Date().toISOString()
  }
  const clientEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !['DEV_TLS_CERT', 'DEV_TLS_KEY', ...perBuildKeys].includes(key))
  )
  const serviceWorkerBuildId = [
    env.VERCEL_GIT_COMMIT_SHA || env.APP_VERSION || 'build',
    env.BUILD_TIME,
  ].join('-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)

  return {
    mode,
    entry: path.resolve(__dirname, 'src', 'main.tsx'),
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: mode === 'production' ? 'assets/[name].[contenthash].js' : 'assets/[name].js',
      publicPath: '/',
      clean: true,
    },
    devtool: mode === 'production' ? 'source-map' : 'eval-cheap-module-source-map',
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      alias: {
        '@farcaster/mini-app-solana': false,
        ...Object.fromEntries(unusedWalletPackages.map((name) => [name, false])),
      },
    },
    target: ['web', 'es2020'],
    optimization: mode === 'production' ? {
      runtimeChunk: 'single',
      splitChunks: {
        cacheGroups: {
          vendor: { test: /[\\/]node_modules[\\/]/, name: 'vendor', chunks: 'initial', enforce: true },
        },
      },
    } : {},
    module: {
      rules: [
        { test: /\.html$/, include: path.resolve(__dirname, 'src'), type: 'asset/source' },
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
            },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        {
          test: /\.(png|jpg|jpeg|gif|svg|mp3)$/i,
          type: 'asset/resource',
          generator: {
            filename: 'assets/[name][ext]',
          },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'public', 'index.html'),
        templateParameters: {
          preconnect: ['https://auth.privy.io', originOf(env.API_BASE_URL)].filter(Boolean),
          startup: fs.readFileSync(path.resolve(__dirname, 'src/components/startup.html'), 'utf8'),
        },
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, 'public', 'sw.js'),
            to: path.resolve(__dirname, 'dist', 'sw.js'),
            transform: (content) => Buffer.from(
              content.toString().replace('__AIFIT_BUILD_ID__', serviceWorkerBuildId)
            ),
          },
          {
            from: path.resolve(__dirname, 'public'),
            to: path.resolve(__dirname, 'dist'),
            globOptions: {
              ignore: ['**/index.html', '**/sw.js'],
            },
          },
        ],
      }),
      new webpack.DefinePlugin({
        'process.env': JSON.stringify(clientEnv),
        ...Object.fromEntries(perBuildKeys.map((key) => [`process.env.${key}`, JSON.stringify(env[key])])),
      }),
    ],
    devServer: {
      ...(mode === 'development' && env.DEV_TLS_CERT && env.DEV_TLS_KEY ? {
        server: {
          type: 'https',
          options: {
            cert: fs.readFileSync(env.DEV_TLS_CERT),
            key: fs.readFileSync(env.DEV_TLS_KEY),
          },
        },
      } : {}),
      static: {
        directory: path.resolve(__dirname, 'public'),
      },
      allowedHosts: ['localhost', '127.0.0.1'],
      historyApiFallback: true,
      port: 5175,
      host: '0.0.0.0',
      hot: true,
      client: {
        overlay: { errors: true, warnings: false },
      },
    },
  }
}
