const http = require('node:http')

const { createApp } = require('./app')

const port = Number.parseInt(process.env.PORT || '3001', 10)
const server = http.createServer(createApp())

server.listen(port, () => {
  console.log(`Chatbot backend listening on http://localhost:${port}`)
})
