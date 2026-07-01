const http = require('node:http')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createApp } = require('../src/app')
const { SchedulingService } = require('../../../modules/scheduling/src')
const { ChannelConnector } = require('../../../modules/channel-connector/src')
const { ChatService } = require('../src/chatService')

async function withServer(run) {
  const schedulingService = new SchedulingService()
  const dependencies = {
    schedulingService,
    channelConnector: new ChannelConnector(),
    chatService: new ChatService({ schedulingService }),
  }

  const server = http.createServer(createApp(dependencies))
  await new Promise((resolve) => server.listen(0, resolve))
  const { port } = server.address()

  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

test('health endpoint exposes module readiness', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`)
    const payload = await response.json()

    assert.equal(payload.status, 'ok')
    assert.deepEqual(payload.modules.channelConnector, ['web', 'email', 'whatsapp', 'facebook'])
  })
})

test('existing patient can start a session, list appointments and reschedule via chat', async () => {
  await withServer(async (baseUrl) => {
    const sessionResponse = await fetch(`${baseUrl}/api/chat/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientCode: 'PAC-0001' }),
    })
    const session = await sessionResponse.json()

    assert.match(session.reply, /PAC-0001/)

    const appointmentsResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'Cand sunt urmatoarele mele programari?',
      }),
    })
    const appointmentsPayload = await appointmentsResponse.json()

    assert.equal(appointmentsPayload.appointments.length, 1)
    assert.match(appointmentsPayload.reply, /Consultatie cardiologie/)

    const rescheduleResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'Te rog sa reprogramezi consultatia pe 2030-08-20 11:15',
      }),
    })
    const reschedulePayload = await rescheduleResponse.json()

    assert.match(reschedulePayload.reply, /Am reprogramat consultatia/)
    assert.equal(reschedulePayload.appointment.startsAt, '2030-08-20T11:15:00.000Z')
  })
})

test('new patient session extracts medical facts in Romanian', async () => {
  await withServer(async (baseUrl) => {
    const sessionResponse = await fetch(`${baseUrl}/api/chat/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Elena',
        lastName: 'Georgescu',
        phone: '+40745555555',
      }),
    })
    const session = await sessionResponse.json()

    assert.match(session.reply, /Ti-am creat fisa initiala/)
    assert.match(session.patient.patientCode, /^PAC-/)

    const messageResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message:
          'Motivul consultatiei este control anual. Simptomele sunt oboseala, ameteli. Alergii penicilina. Tratamentul curent este magneziu.',
      }),
    })
    const payload = await messageResponse.json()

    assert.deepEqual(payload.medicalRecord.symptoms, ['oboseala', 'ameteli'])
    assert.deepEqual(payload.medicalRecord.medication, ['magneziu'])
    assert.equal(payload.medicalRecord.visitReason, 'control anual')
  })
})
