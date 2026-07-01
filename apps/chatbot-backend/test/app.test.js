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
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  })
})

test('preflight request returns CORS headers', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/chat/session/start`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })

    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.match(response.headers.get('access-control-allow-methods') || '', /POST/)
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
    assert.equal(reschedulePayload.appointment.startsAt, '2030-08-20T11:15:00.000')
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

test('new patient can request a new appointment from chat and then list it', async () => {
  await withServer(async (baseUrl) => {
    const sessionResponse = await fetch(`${baseUrl}/api/chat/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Mihai',
        lastName: 'Vasilescu',
        phone: '+40746666666',
      }),
    })
    const session = await sessionResponse.json()

    const startBookingResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'Doresc o programare',
      }),
    })
    const startBookingPayload = await startBookingResponse.json()
    assert.match(startBookingPayload.reply, /Ce data doresti\?/)

    const addTimeResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'Pe 2031-01-10 la 15:00',
      }),
    })
    const addTimePayload = await addTimeResponse.json()
    assert.match(addTimePayload.reply, /La ce specialitate doresti consultatia/)

    const createAppointmentResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'cardiologie',
      }),
    })
    const createPayload = await createAppointmentResponse.json()
    assert.match(createPayload.reply, /Te-am programat la Cardiologie pe 10\.01\.2031 la 15:00/)
    assert.equal(createPayload.appointment.reason, 'Consultatie Cardiologie')
    assert.equal(createPayload.appointment.startsAt, '2031-01-10T15:00:00.000')

    const listResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'cand este urmatoarea consultatie?',
      }),
    })
    const listPayload = await listResponse.json()

    assert.equal(listPayload.appointments.length, 1)
    assert.match(listPayload.reply, /Urmatoarele programari sunt/)
  })
})

test('booking with relative weekday infers current/next week and year', async () => {
  await withServer(async (baseUrl) => {
    const sessionResponse = await fetch(`${baseUrl}/api/chat/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientCode: 'PAC-0001' }),
    })
    const session = await sessionResponse.json()

    const startBookingResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'doresc o noua programare',
      }),
    })
    const startBookingPayload = await startBookingResponse.json()
    assert.match(startBookingPayload.reply, /Ce data doresti\?/)

    const relativeDateResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'marti la 12 se poate?',
      }),
    })
    const relativeDatePayload = await relativeDateResponse.json()

    assert.match(relativeDatePayload.reply, /La ce specialitate doresti consultatia/i)
    assert.match(relativeDatePayload.reply, /data: \d{2}\.\d{2}\.\d{4}/i)
    assert.match(relativeDatePayload.reply, /ora: 12:00/i)
  })
})

test('emergency detection directs patient to call 112', async () => {
  await withServer(async (baseUrl) => {
    const sessionResponse = await fetch(`${baseUrl}/api/chat/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Ion',
        lastName: 'Popescu',
        phone: '+40741234567',
      }),
    })
    const session = await sessionResponse.json()

    const emergencyResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'Am durere in piept si greu sa respir',
      }),
    })
    const emergencyPayload = await emergencyResponse.json()

    assert.match(emergencyPayload.reply, /112/i)
    assert.match(emergencyPayload.reply, /Urgente/i)
  })
})

test('health complaint suggests relevant specialty and sets it for booking', async () => {
  await withServer(async (baseUrl) => {
    const sessionResponse = await fetch(`${baseUrl}/api/chat/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Ana',
        lastName: 'Marinescu',
        phone: '+40745678901',
      }),
    })
    const session = await sessionResponse.json()

    const complaintResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'Am dureri de cap frecvente',
      }),
    })
    const complaintPayload = await complaintResponse.json()

    assert.match(complaintPayload.reply, /neurologie/i)
    assert.match(complaintPayload.reply, /programare/i)
    assert.match(complaintPayload.reply, /Doresti/i)

    const confirmResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: 'Da, as dori o programare',
      }),
    })
    const confirmPayload = await confirmResponse.json()

    assert.match(confirmPayload.reply, /Ce data doresti/i)

    const dateResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: '2026-08-15',
      }),
    })
    const datePayload = await dateResponse.json()

    assert.match(datePayload.reply, /La ce ora/i)

    const timeResponse = await fetch(`${baseUrl}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        message: '14:00',
      }),
    })
    const timePayload = await timeResponse.json()

    assert.match(timePayload.reply, /Te-am programat/i)
    assert.match(timePayload.reply, /Neurologie/i)
    assert.equal(timePayload.appointment.reason, 'Consultatie Neurologie')
  })
})
