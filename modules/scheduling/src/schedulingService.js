const { randomUUID } = require('node:crypto')

class GoogleCalendarAdapter {
  async upsertAppointment(appointment) {
    return {
      provider: 'google-calendar',
      status: 'stubbed',
      appointmentId: appointment.id,
    }
  }
}

class ExternalMedicalApiAdapter {
  async syncPatient(patient) {
    return {
      provider: 'medical-api',
      status: 'stubbed',
      patientCode: patient.patientCode,
    }
  }
}

class SchedulingService {
  constructor({
    googleCalendarAdapter = new GoogleCalendarAdapter(),
    externalMedicalApiAdapter = new ExternalMedicalApiAdapter(),
    seedDemoData = true,
  } = {}) {
    this.googleCalendarAdapter = googleCalendarAdapter
    this.externalMedicalApiAdapter = externalMedicalApiAdapter
    this.patients = new Map()
    this.appointments = new Map()
    this.lastNumericCode = 0

    if (seedDemoData) {
      this.seedDemoData()
    }
  }

  seedDemoData() {
    const patient = this.createPatient(
      {
        firstName: 'Maria',
        lastName: 'Ionescu',
        phone: '+40740000000',
        email: 'maria@example.com',
        birthDate: '1990-05-14',
      },
      { patientCode: 'PAC-0001' },
    )

    this.scheduleAppointment({
      patientCode: patient.patientCode,
      startsAt: '2030-08-14T09:00:00.000Z',
      reason: 'Consultatie cardiologie',
      source: 'database',
    })
  }

  generatePatientCode() {
    this.lastNumericCode += 1
    return `PAC-${String(this.lastNumericCode).padStart(4, '0')}`
  }

  createPatient(basicData, options = {}) {
    const patientCode = options.patientCode || this.generatePatientCode()
    const patient = {
      id: randomUUID(),
      patientCode,
      createdAt: new Date().toISOString(),
      medicalRecord: {},
      ...basicData,
    }

    this.lastNumericCode = Math.max(
      this.lastNumericCode,
      Number.parseInt(patientCode.replace(/\D/g, ''), 10) || 0,
    )

    this.patients.set(patientCode, patient)
    return patient
  }

  findPatientByCode(patientCode) {
    return this.patients.get(patientCode) || null
  }

  updateMedicalRecord(patientCode, patch) {
    const patient = this.findPatientByCode(patientCode)

    if (!patient) {
      return null
    }

    patient.medicalRecord = {
      ...patient.medicalRecord,
      ...patch,
    }

    return patient.medicalRecord
  }

  async syncPatient(patientCode) {
    const patient = this.findPatientByCode(patientCode)

    if (!patient) {
      throw new Error('Patient not found')
    }

    return this.externalMedicalApiAdapter.syncPatient(patient)
  }

  scheduleAppointment({ patientCode, startsAt, reason, source = 'database' }) {
    const patient = this.findPatientByCode(patientCode)

    if (!patient) {
      throw new Error('Patient not found')
    }

    const appointment = {
      id: randomUUID(),
      patientCode,
      startsAt,
      reason,
      source,
      calendarSync: 'pending',
    }

    this.appointments.set(appointment.id, appointment)
    return appointment
  }

  listUpcomingAppointments(patientCode) {
    return [...this.appointments.values()]
      .filter(
        (appointment) =>
          appointment.patientCode === patientCode && new Date(appointment.startsAt) >= new Date(),
      )
      .sort((left, right) => new Date(left.startsAt) - new Date(right.startsAt))
  }

  async rescheduleAppointment({ patientCode, appointmentId, startsAt }) {
    const appointment = this.appointments.get(appointmentId)

    if (!appointment || appointment.patientCode !== patientCode) {
      throw new Error('Appointment not found')
    }

    appointment.startsAt = startsAt
    appointment.calendarSync = 'updated'
    appointment.googleCalendar = await this.googleCalendarAdapter.upsertAppointment(appointment)
    return appointment
  }
}

module.exports = {
  ExternalMedicalApiAdapter,
  GoogleCalendarAdapter,
  SchedulingService,
}
