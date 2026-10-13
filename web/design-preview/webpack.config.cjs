const path = require('path')
process.env.PRIVY_APP_ID = 'design-preview'
process.env.API_BASE_URL = 'http://localhost:8199'
const base = require('../webpack.config.cjs')

module.exports = (env, argv) => {
  const config = base(env, argv)
  config.output = { ...config.output, path: path.resolve(__dirname, '..', 'dist-preview') }
  config.resolve.alias['@privy-io/react-auth'] = path.resolve(__dirname, 'privy-stub.tsx')
  return config
}
