const test = require('node:test')
const assert = require('node:assert/strict')

const { SchedulingService } = require('../src')

test('creates patients with generated codes and lists upcoming appointments', () => {
  const schedulingService = new SchedulingService({ seedDemoData: false })
  const patient = schedulingService.createPatient({
    firstName: 'Ana',
    lastName: 'Pop',
    phone: '+40741111111',
  })

  assert.equal(patient.patientCode, 'PAC-0001')

  const appointment = schedulingService.scheduleAppointment({
    patientCode: patient.patientCode,
    startsAt: '2030-09-01T10:00:00.000Z',
    reason: 'Consultatie generala',
  })

  assert.deepEqual(schedulingService.listUpcomingAppointments(patient.patientCode), [appointment])
})

test('reschedules an appointment and marks it for calendar sync', async () => {
  const schedulingService = new SchedulingService()
  const [appointment] = schedulingService.listUpcomingAppointments('PAC-0001')

  const updated = await schedulingService.rescheduleAppointment({
    patientCode: 'PAC-0001',
    appointmentId: appointment.id,
    startsAt: '2030-08-15T12:30:00.000Z',
  })

  assert.equal(updated.startsAt, '2030-08-15T12:30:00.000Z')
  assert.equal(updated.calendarSync, 'updated')
  assert.equal(updated.googleCalendar.provider, 'google-calendar')
})
