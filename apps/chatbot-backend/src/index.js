const path = require('node:path')
const http = require('node:http')
const dotenv = require('dotenv')

// Load root-level .env first, then allow backend .env values to override it.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') })
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true })

const { createApp } = require('./app')

const port = Number.parseInt(process.env.PORT || '3001', 10)
const server = http.createServer(createApp())

server.listen(port, () => {
  console.log(`Chatbot backend listening on http://localhost:${port}`)
})
