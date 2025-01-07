const path = require('path');

module.exports = {
  entry: './public/script.js', // Entry point of your application
  output: {
    filename: 'bundle.js', // Output bundled file name
    path: path.resolve(__dirname, 'public/dist'), // Output directory
  },
  mode: 'development', // Set to 'production' for production builds
  devtool: 'inline-source-map', // Add source maps for easier debugging
  module: {
    rules: [
      {
        test: /\.js$/, // Apply this rule to all .js files
        exclude: /node_modules/, // Exclude the node_modules directory
        use: {
          loader: 'babel-loader', // Use babel-loader for transpiling
          options: {
            presets: ['@babel/preset-env'], // Use the @babel/preset-env preset
          },
        },
      },
    ],
  },
};