const { ChannelConnector } = require('../../../modules/channel-connector/src')
const { SchedulingService } = require('../../../modules/scheduling/src')
const { ChatService, validateBasicData } = require('./chatService')

function createDependencies() {
  const schedulingService = new SchedulingService()
  const channelConnector = new ChannelConnector()
  const chatService = new ChatService({ schedulingService })

  return {
    channelConnector,
    chatService,
    schedulingService,
  }
}

function createApp(dependencies = createDependencies()) {
  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost')
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : null

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, {
          status: 'ok',
          modules: {
            chatbotBackend: 'ready',
            scheduling: 'ready',
            channelConnector: dependencies.channelConnector.listChannels(),
          },
        })
      }

      if (req.method === 'POST' && url.pathname === '/api/patients') {
        const patient = dependencies.schedulingService.createPatient(validateBasicData(body))
        return sendJson(res, 201, { patient })
      }

      if (req.method === 'POST' && url.pathname === '/api/chat/session/start') {
        const session = dependencies.chatService.startSession(body)
        return sendJson(res, 200, session)
      }

      if (req.method === 'POST' && url.pathname === '/api/chat/message') {
        const result = await dependencies.chatService.handleMessage(body)
        return sendJson(res, 200, result)
      }

      const appointmentMatch = url.pathname.match(/^\/api\/patients\/([^/]+)\/appointments$/)
      if (req.method === 'GET' && appointmentMatch) {
        return sendJson(res, 200, {
          appointments: dependencies.schedulingService.listUpcomingAppointments(appointmentMatch[1]),
        })
      }

      const rescheduleMatch = url.pathname.match(/^\/api\/patients\/([^/]+)\/appointments\/reschedule$/)
      if (req.method === 'POST' && rescheduleMatch) {
        const appointment = await dependencies.schedulingService.rescheduleAppointment({
          patientCode: rescheduleMatch[1],
          appointmentId: body.appointmentId,
          startsAt: body.startsAt,
        })
        return sendJson(res, 200, { appointment })
      }

      const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/inbound$/)
      if (req.method === 'POST' && channelMatch) {
        const message = await dependencies.channelConnector.receive(channelMatch[1], body)
        return sendJson(res, 200, { message })
      }

      return sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      return sendJson(res, 400, { error: error.message })
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    req.on('data', (chunk) => {
      buffer += chunk
    })
    req.on('end', () => {
      if (!buffer) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(buffer))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

module.exports = {
  createApp,
  createDependencies,
}
